import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createNoopCache, createRedisCache, type CacheClient } from '../../src/cache/redisCache.js';
import { loadEnv } from '../../src/config/env.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const redisUrl = process.env.REDIS_URL;

let app: FastifyInstance;
let cache: CacheClient;
afterEach(async () => {
  await app?.close();
  await cache?.close();
});

describe('health endpoints (integration)', () => {
  it('reports cache as disabled and overall status ok when Redis is not configured', async () => {
    cache = createNoopCache();
    app = await buildApp({
      env,
      checkDb: async () => true,
      checkCache: () => cache.ping(),
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
      cache = createRedisCache({ url: redisUrl! });
      app = await buildApp({
        env,
        checkDb: async () => true,
        checkCache: () => cache.ping(),
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
