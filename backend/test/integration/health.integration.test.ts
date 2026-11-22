import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createCacheCheck } from '../../src/cache/check.js';
import { loadEnv } from '../../src/config/env.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const redisUrl = process.env.REDIS_URL;

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('health endpoints (integration)', () => {
  it('reports cache as disabled and overall status ok when Redis is not configured', async () => {
    app = await buildApp({
      env,
      checkDb: async () => true,
      checkCache: createCacheCheck(undefined),
      logger: false,
    });
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', cache: 'disabled' },
    });
  });

  describe.skipIf(!redisUrl)('with a real Redis instance (REDIS_URL set)', () => {
    it('reports cache as ok', async () => {
      app = await buildApp({
        env,
        checkDb: async () => true,
        checkCache: createCacheCheck(redisUrl),
        logger: false,
      });
      const res = await app.inject('/health/ready');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ok',
        checks: { database: 'ok', cache: 'ok' },
      });
    });
  });
});
