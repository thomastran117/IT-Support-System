import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashCorrelationId } from '@smartdesk/service-runtime';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const up = async () => true;
let app: FastifyInstance;
afterEach(async () => app?.close());

describe('api', () => {
  it('serves a successful route in the envelope', async () => {
    app = await buildApp({
      env,
      checkDb: up,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
    const res = await app.inject('/api/ping');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ message: 'pong', error: null, details: null });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('rejects invalid payload with 400', async () => {
    app = await buildApp({
      env,
      checkDb: up,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
    const res = await app.inject({ method: 'POST', url: '/api/echo', payload: { nope: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
  });

  it('returns a safe 404 for unknown routes', async () => {
    app = await buildApp({
      env,
      checkDb: up,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
    const res = await app.inject('/api/missing');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not Found', data: null });
  });

  it('returns 400 for malformed JSON', async () => {
    app = await buildApp({
      env,
      checkDb: up,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
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
      checkCache: async () => 'disabled' as const,
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
    app = await buildApp({
      env,
      checkDb: up,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
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
      checkCache: async () => 'disabled' as const,
      logger: { level: 'info', stream },
      extraRoutes: (scope) => {
        scope.post('/secret/:id', async () => {
          throw new Error('secret-provider-key');
        });
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/secret/secret-parameter?text=secret-query',
      headers: {
        authorization: 'Bearer secret-token',
        cookie: 'sid=secret-cookie',
        'x-request-id': 'secret-client-id',
      },
      payload: { description: 'secret-ticket-body' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-request-id']).toBe('secret-client-id');
    const records = lines.map((line) => JSON.parse(line) as object);
    expect(records).toContainEqual(
      expect.objectContaining({
        service: 'backend',
        event: 'http_request',
        route: '/api/secret/:id',
        correlationId: hashCorrelationId('secret-client-id'),
        outcome: 'server_error',
        status: 500,
        durationMs: expect.any(Number),
      }),
    );
    const out = lines.join('');
    for (const secret of [
      'secret-token',
      'secret-cookie',
      'secret-client-id',
      'secret-parameter',
      'secret-query',
      'secret-ticket-body',
      'secret-provider-key',
    ]) {
      expect(out).not.toContain(secret);
    }
  });
});

describe('health', () => {
  it('live is ok even when the database is down', async () => {
    app = await buildApp({
      env,
      checkDb: async () => false,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
    expect((await app.inject('/health/live')).statusCode).toBe(200);
  });

  it('ready is 200 when the db is up', async () => {
    app = await buildApp({
      env,
      checkDb: up,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
  });

  it('ready is 503 when the db is down', async () => {
    app = await buildApp({
      env,
      checkDb: async () => false,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toBe('unavailable');
  });

  it('reports the cache check result without it affecting overall status', async () => {
    app = await buildApp({
      env,
      checkDb: up,
      checkCache: async () => 'unavailable' as const,
      logger: false,
    });
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.cache).toBe('unavailable');
  });

  it('reports cache as disabled when Redis is not configured', async () => {
    app = await buildApp({
      env,
      checkDb: up,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.cache).toBe('disabled');
  });
});
