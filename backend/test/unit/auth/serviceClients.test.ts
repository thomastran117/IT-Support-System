import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import {
  createDelegatedIdentityResolver,
  ServiceRequestError,
} from '@smartdesk/service-runtime/delegated-identity';
import {
  createServiceTokenVerifier,
  createSystemServiceClient,
} from '@smartdesk/service-runtime/service-tokens';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * SD-053: the shared runtime's outbound credential clients, end to end over loopback HTTP: the
 * token each client signs must satisfy the receiving service's verifier, and every failure must
 * collapse to the caller's fallback (system calls) or a fixed 401/503 (delegated identity).
 */
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function serve(listener: RequestListener) {
  const server = createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

async function caller(grants: Record<string, 'system' | 'user'>) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const config = {
    kid: 'caller-test',
    service: 'test-caller',
    publicKey: await exportSPKI(publicKey),
    grants,
  };
  return { privateKey: await exportPKCS8(privateKey), config };
}

const bearer = (headers: IncomingHttpHeaders) =>
  headers.authorization?.replace(/^Bearer /, '') ?? '';

describe('createSystemServiceClient', () => {
  const route = {
    path: '/internal/test',
    scope: 'ticket:test-system',
    audience: 'smartdesk-ticket',
  };

  it('signs a short-lived system credential the receiving verifier authorizes', async () => {
    const key = await caller({ [route.scope]: 'system' });
    const verify = await createServiceTokenVerifier(route.audience, [key.config]);
    const seen: { verdict?: unknown; body?: string; requestId?: string } = {};
    const origin = await serve(async (req, res) => {
      seen.verdict = await verify(bearer(req.headers), route.scope, 'system');
      seen.requestId = req.headers['x-request-id'] as string;
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.body = body;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    const call = await createSystemServiceClient({
      origin,
      route,
      kid: key.config.kid,
      privateKey: key.privateKey,
      service: key.config.service,
      keySetting: 'TEST_KEY',
      timeoutMs: 2000,
    });
    expect(await call({ ticketId: 't-1' }, (b) => b as { ok: boolean }, 'req-1')).toEqual({
      ok: true,
    });
    expect(seen.verdict).toEqual({
      result: 'authorized',
      service: 'test-caller',
      actor: { kind: 'system' },
    });
    expect(seen.body).toBe('{"ticketId":"t-1"}');
    expect(seen.requestId).toBe('req-1');

    // A verifier for another audience, or one that never granted the scope, refuses the same token.
    let token = '';
    const capture = await serve((req, res) => {
      token = bearer(req.headers);
      res.end('{}');
    });
    const other = await createSystemServiceClient({
      origin: capture,
      route,
      kid: key.config.kid,
      privateKey: key.privateKey,
      service: key.config.service,
      keySetting: 'TEST_KEY',
      timeoutMs: 2000,
    });
    await other({}, (b) => b);
    const foreign = await createServiceTokenVerifier('smartdesk-ai', [key.config]);
    expect(await foreign(token, route.scope, 'system')).toEqual({ result: 'unauthenticated' });
    const ungranted = await createServiceTokenVerifier(route.audience, [
      { ...key.config, grants: { 'ticket:other': 'system' } },
    ]);
    expect(await ungranted(token, route.scope, 'system')).toEqual({ result: 'forbidden' });
  });

  it('returns undefined for non-2xx, undecodable, slow and unreachable responses', async () => {
    const key = await caller({ [route.scope]: 'system' });
    const make = (origin: URL, timeoutMs = 2000) =>
      createSystemServiceClient({
        origin,
        route,
        kid: key.config.kid,
        privateKey: key.privateKey,
        service: key.config.service,
        keySetting: 'TEST_KEY',
        timeoutMs,
      });
    const failing = await make(await serve((_req, res) => res.writeHead(500).end('secret detail')));
    expect(await failing({}, (b) => b)).toBeUndefined();
    const ok = await make(await serve((_req, res) => res.end('{"x":1}')));
    expect(
      await ok({}, () => {
        throw new Error('schema mismatch');
      }),
    ).toBeUndefined();
    const slow = await make(await serve(() => {}), 100);
    expect(await slow({}, (b) => b)).toBeUndefined();
    const unreachable = await make(new URL('http://127.0.0.1:1'));
    expect(await unreachable({}, (b) => b)).toBeUndefined();
  });

  it('rejects a private key that is not P-256 PKCS#8 without echoing it', async () => {
    const attempt = createSystemServiceClient({
      origin: new URL('http://127.0.0.1:1'),
      route,
      kid: 'k',
      privateKey: 'not-a-key',
      service: 's',
      keySetting: 'TEST_KEY',
      timeoutMs: 100,
    });
    await expect(attempt).rejects.toThrow('TEST_KEY must contain a P-256 PKCS#8 private key');
  });
});

describe('createDelegatedIdentityResolver', () => {
  const route = {
    audience: 'smartdesk-identity',
    scope: 'identity:test-principal',
    path: '/internal/identity/test-principal',
  };

  async function resolver(identity: RequestListener) {
    const key = await caller({ [route.scope]: 'user' });
    const origin = await serve(identity);
    return {
      key,
      resolve: await createDelegatedIdentityResolver({
        identityOrigin: origin,
        keyId: key.config.kid,
        privateKey: key.privateKey,
        keySetting: 'TEST_KEY',
        service: key.config.service,
        route,
        decode: (body) => body as { id: string },
      }),
    };
  }

  it('binds the delegated credential to the hash of the forwarded user token', async () => {
    let verdict: unknown;
    let forwarded: string | undefined;
    const verify = {
      fn: undefined as undefined | Awaited<ReturnType<typeof createServiceTokenVerifier>>,
    };
    const { key, resolve } = await resolver(async (req, res) => {
      verdict = await verify.fn!(bearer(req.headers), route.scope, 'user');
      forwarded = req.headers['x-smartdesk-internal-user-token'] as string;
      res.end('{"id":"u-1"}');
    });
    verify.fn = await createServiceTokenVerifier(route.audience, [key.config]);
    expect(await resolve('Bearer user-access-token', 'req-1')).toEqual({ id: 'u-1' });
    expect(forwarded).toBe('user-access-token');
    expect(verdict).toEqual({
      result: 'authorized',
      service: 'test-caller',
      actor: {
        kind: 'user',
        tokenHash: createHash('sha256').update('user-access-token').digest('base64url'),
      },
    });
  });

  it('maps a missing bearer and an identity 401 to 401, everything else to 503', async () => {
    let calls = 0;
    let status = 401;
    let body = '{}';
    const { resolve } = await resolver((_req, res) => {
      calls++;
      res.writeHead(status).end(body);
    });
    const outcome = (authorization: string | undefined) =>
      resolve(authorization, 'req').then(
        () => 'ok',
        (e: unknown) => (e instanceof ServiceRequestError ? e.status : 'other'),
      );

    for (const header of [undefined, '', 'Basic abc', 'Bearer']) {
      expect(await outcome(header)).toBe(401);
    }
    expect(calls).toBe(0);
    expect(await outcome('Bearer t')).toBe(401);
    status = 500;
    expect(await outcome('Bearer t')).toBe(503);
    status = 200;
    body = 'not json';
    expect(await outcome('Bearer t')).toBe(503);
  });

  it('fails closed with 503 when Identity is unreachable', async () => {
    const key = await caller({ [route.scope]: 'user' });
    const resolve = await createDelegatedIdentityResolver({
      identityOrigin: new URL('http://127.0.0.1:1'),
      keyId: key.config.kid,
      privateKey: key.privateKey,
      keySetting: 'TEST_KEY',
      service: key.config.service,
      route,
      decode: (b) => b,
    });
    await expect(resolve('Bearer t', 'req')).rejects.toMatchObject({ status: 503 });
  });
});
