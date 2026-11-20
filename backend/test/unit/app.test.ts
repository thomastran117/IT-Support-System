import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, REDACT_PATHS } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const up = async () => true;
let app: FastifyInstance;
afterEach(async () => app?.close());

describe('api', () => {
  it('serves a successful route in the envelope', async () => {
    app = await buildApp({ env, checkDb: up, logger: false });
    const res = await app.inject('/api/ping');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ message: 'pong', error: null, details: null });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('rejects invalid payload with 400', async () => {
    app = await buildApp({ env, checkDb: up, logger: false });
    const res = await app.inject({ method: 'POST', url: '/api/echo', payload: { nope: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
  });

  it('returns a safe 404 for unknown routes', async () => {
    app = await buildApp({ env, checkDb: up, logger: false });
    const res = await app.inject('/api/missing');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not Found', data: null });
  });

  it('returns 400 for malformed JSON', async () => {
    app = await buildApp({ env, checkDb: up, logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
  });

  it('does not leak internals on unexpected errors', async () => {
    app = await buildApp({
      env,
      checkDb: up,
      logger: false,
      extraRoutes: (scope) => {
        scope.get('/crash', async () => {
          throw new Error('secret db password leaked');
        });
      },
    });
    const res = await app.inject('/api/crash');
    expect(res.statusCode).toBe(500);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain('secret');
    expect(body).not.toMatch(/stack|\.ts/);
  });

  it('restricts CORS to the configured origin', async () => {
    app = await buildApp({ env, checkDb: up, logger: false });
    const ok = await app.inject({ url: '/api/ping', headers: { origin: 'http://app.test' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://app.test');
    const bad = await app.inject({ url: '/api/ping', headers: { origin: 'http://evil.test' } });
    expect(bad.headers['access-control-allow-origin']).not.toBe('http://evil.test');
  });

  it('redacts sensitive data from logs', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    app = await buildApp({
      env,
      checkDb: up,
      logger: { level: 'info', redact: { paths: REDACT_PATHS, censor: '[Redacted]' }, stream },
    });
    await app.inject({
      url: '/api/ping',
      headers: { authorization: 'Bearer secret-token', cookie: 'sid=secret-cookie' },
    });
    const out = lines.join('');
    expect(out).toContain('"req"');
    expect(out).not.toContain('secret-token');
    expect(out).not.toContain('secret-cookie');
  });
});

describe('health', () => {
  it('live is ok even when the database is down', async () => {
    app = await buildApp({ env, checkDb: async () => false, logger: false });
    expect((await app.inject('/health/live')).statusCode).toBe(200);
  });

  it('ready is 200 when the db is up', async () => {
    app = await buildApp({ env, checkDb: up, logger: false });
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
  });

  it('ready is 503 when the db is down', async () => {
    app = await buildApp({ env, checkDb: async () => false, logger: false });
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toBe('unavailable');
  });
});
