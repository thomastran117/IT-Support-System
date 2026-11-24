import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createInternalGuard, DELEGATED_USER_TOKEN_HEADER } from '../../src/auth/internalGuard.js';
import { createServiceTokenVerifier } from '../../src/auth/serviceTokens.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { registerErrorHandling } from '../../src/plugins/errors.js';
import {
  createServiceFixture,
  delegatedActor,
  systemScope,
  ticketAudience,
  workScope,
} from '../fixtures/serviceCredentials.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('internal service authentication', () => {
  const prisma = createTestPrisma();
  const closedByDefault = loadEnv({});
  const userTokens = new TokenService(closedByDefault);
  const url = `/internal/tickets/${TICKETS.vpn}/work-access`;
  const checkDb = async () => true;
  const checkCache = async () => 'disabled' as const;
  const forgeActorHeaders = {
    'x-actor-role': 'ADMIN',
    'x-user-id': USERS.admin,
    'x-smartdesk-internal-actor': 'admin',
  };
  const logs: string[] = [];
  let app: FastifyInstance;
  let caller: Awaited<ReturnType<typeof createServiceFixture>>;

  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    caller = await createServiceFixture();
    const env = loadEnv({ INTERNAL_SERVICE_KEYS: JSON.stringify([caller.config]) });
    app = await buildApp({
      env,
      prisma,
      checkDb,
      checkCache,
      logger: {
        level: 'info',
        stream: new Writable({
          write(chunk, _encoding, done) {
            logs.push(String(chunk));
            done();
          },
        }),
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  async function delegate(token: string) {
    const serviceToken = await caller.sign({ scope: workScope, actor: delegatedActor(token) });
    return { authorization: `Bearer ${serviceToken}`, [DELEGATED_USER_TOKEN_HEADER]: token };
  }

  it('keeps the route disabled without a caller registry', async () => {
    const disabled = await buildApp({
      env: closedByDefault,
      prisma,
      checkDb,
      checkCache,
      logger: false,
    });
    try {
      expect((await disabled.inject({ url })).statusCode).toBe(404);
      expect((await disabled.inject({ url: '/api/ping' })).statusCode).toBe(200);
    } finally {
      await disabled.close();
    }
  });

  it('rejects requests without a service credential even when supplied actor and user headers', async () => {
    const token = await userTokens.sign('access', USERS.admin, 0);
    const headers = { ...forgeActorHeaders, [DELEGATED_USER_TOKEN_HEADER]: token };
    const direct = await app.inject({ url, headers });
    expect(direct.statusCode).toBe(401);
    expect(direct.json()).toEqual({
      message: 'Service authentication required',
      error: 'Unauthorized',
      details: null,
      data: null,
    });
    const preflight = await app.inject({
      method: 'OPTIONS',
      url,
      headers: { origin: closedByDefault.frontendOrigin, 'access-control-request-method': 'GET' },
    });
    expect(preflight.statusCode).toBe(404);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (await app.inject({ url, headers: { ...headers, authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(401);
  });

  it('validates the service audience, lifetime, actor kind and token binding on the live route', async () => {
    const token = await userTokens.sign('access', USERS.tara, 0);
    const actor = delegatedActor(token);
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [{ aud: 'smartdesk-ai' }, { exp: now - 1, iat: now - 30 }]) {
      const serviceToken = await caller.sign({ scope: workScope, actor, ...claims });
      const headers = {
        authorization: `Bearer ${serviceToken}`,
        [DELEGATED_USER_TOKEN_HEADER]: token,
      };
      expect((await app.inject({ url, headers })).statusCode).toBe(401);
    }
    const systemToken = await caller.sign({ scope: workScope });
    expect(
      (await app.inject({ url, headers: { authorization: `Bearer ${systemToken}` } })).statusCode,
    ).toBe(403);
    const headers = await delegate(token);
    expect(
      (await app.inject({ url, headers: { authorization: headers.authorization } })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url,
          headers: {
            ...headers,
            [DELEGATED_USER_TOKEN_HEADER]: await userTokens.sign('access', USERS.admin, 0),
          },
        })
      ).statusCode,
    ).toBe(401);
    const refresh = await userTokens.sign('refresh', USERS.tara, 0);
    expect((await app.inject({ url, headers: await delegate(refresh) })).statusCode).toBe(401);
  });

  it('uses the existing role, ticket and active-team policy for the verified user', async () => {
    const user = await userTokens.sign('access', USERS.tara, 0);
    const headers = await delegate(user);
    const allowed = await app.inject({
      url,
      headers: { ...headers, 'x-request-id': 'internal-test' },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(allowed.headers['x-request-id']).toBe('internal-test');
    expect(allowed.headers['access-control-allow-origin']).toBeUndefined();
    expect(logs.join('')).not.toContain(user);
    expect(logs.join('')).not.toContain(headers.authorization);

    const employee = await userTokens.sign('access', USERS.erin, 0);
    const denied = await app.inject({
      url,
      headers: { ...(await delegate(employee)), ...forgeActorHeaders },
    });
    expect(denied.statusCode).toBe(403);
    const otherTeam = await userTokens.sign('access', USERS.hana, 0);
    expect((await app.inject({ url, headers: await delegate(otherTeam) })).statusCode).toBe(404);

    await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: false } });
    try {
      expect((await app.inject({ url, headers })).statusCode).toBe(404);
    } finally {
      await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: true } });
    }
  });

  it('applies current account activation and token version in both public and internal routes', async () => {
    const inactive = await userTokens.sign('access', USERS.ivan, 0);
    expect((await app.inject({ url, headers: await delegate(inactive) })).statusCode).toBe(401);
    const active = await userTokens.sign('access', USERS.tara, 0);
    const headers = await delegate(active);
    await prisma.user.update({ where: { id: USERS.tara }, data: { tokenVersion: 1 } });
    try {
      expect((await app.inject({ url, headers })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: '/api/auth/me',
            headers: { authorization: `Bearer ${active}` },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await prisma.user.update({ where: { id: USERS.tara }, data: { tokenVersion: 0 } });
    }
  });

  it('keeps system actors separate from delegated users on a guarded operation', async () => {
    const systemApp = Fastify();
    registerErrorHandling(systemApp);
    const verify = await createServiceTokenVerifier(ticketAudience, [caller.config]);
    const guard = createInternalGuard(prisma, userTokens, verify);
    systemApp.get(
      '/system',
      { preHandler: guard(systemScope, 'system') },
      async (req) => req.internalActor,
    );
    try {
      const authorization = `Bearer ${await caller.sign()}`;
      const system = await systemApp.inject({ url: '/system', headers: { authorization } });
      expect(system.statusCode).toBe(200);
      expect(system.json()).toEqual({ kind: 'system', service: caller.config.service });
      const conflicting = await systemApp.inject({
        url: '/system',
        headers: { authorization, [DELEGATED_USER_TOKEN_HEADER]: 'another-credential' },
      });
      expect(conflicting.statusCode).toBe(403);
    } finally {
      await systemApp.close();
    }
  });
});
