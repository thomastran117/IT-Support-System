import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../../src/app.js';
import { createRedisConnection } from '../../src/cache/redisCache.js';
import { loadEnv } from '../../src/config/env.js';
import { createFallbackRateLimitStore } from '../../src/rateLimit/fallbackStore.js';
import { DEMO_PASSWORD } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const ORIGIN = 'http://app.test';
const env = loadEnv({ FRONTEND_ORIGIN: ORIGIN });
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!testDatabaseUrl || !redisUrl)('distributed rate limiting (integration)', () => {
  const prisma = createTestPrisma();
  const apps: FastifyInstance[] = [];
  const connections: ReturnType<typeof createRedisConnection>[] = [];

  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await Promise.all(connections.splice(0).map((c) => c.disconnect()));
    apps.splice(0);
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  /** A fresh Redis connection and rate-limit store, so each "instance" is independent except for
   * sharing `namespace` -- exactly how two real backend processes would each hold their own
   * connection to one shared Redis server. */
  const buildInstance = async (
    namespace: string,
    extra: Partial<AppOptions> = {},
    connect: () => ReturnType<typeof createRedisConnection> = () =>
      createRedisConnection({ url: redisUrl! }),
  ) => {
    const redis = connect();
    connections.push(redis);
    const app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
      logger: false,
      authRateLimit: { login: 1000, refresh: 1000, windowMs: 60_000 },
      rateLimitStore: createFallbackRateLimitStore(redis, namespace),
      ...extra,
    });
    apps.push(app);
    return app;
  };

  const login = (app: FastifyInstance, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { email: 'erin@smartdesk.test', password: DEMO_PASSWORD },
    });

  it('shares one quota across two backend instances', async () => {
    const namespace = `test-rl-${randomUUID()}-`;
    const appA = await buildInstance(namespace, {
      authRateLimit: { login: 3, refresh: 3, windowMs: 60_000 },
    });
    const appB = await buildInstance(namespace, {
      authRateLimit: { login: 3, refresh: 3, windowMs: 60_000 },
    });

    expect((await login(appA)).statusCode).toBe(200);
    expect((await login(appB)).statusCode).toBe(200);
    expect((await login(appA)).statusCode).toBe(200);
    // The 4th request total, on a third app pointed at the same namespace, finds the shared
    // budget already spent -- the two earlier instances were not counting independently.
    const appC = await buildInstance(namespace, {
      authRateLimit: { login: 3, refresh: 3, windowMs: 60_000 },
    });
    expect((await login(appC)).statusCode).toBe(429);
  });

  it('returns the budget once the window expires', async () => {
    const namespace = `test-rl-${randomUUID()}-`;
    const app = await buildInstance(namespace, {
      authRateLimit: { login: 1, refresh: 1, windowMs: 300 },
    });

    expect((await login(app)).statusCode).toBe(200);
    expect((await login(app)).statusCode).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await login(app)).statusCode).toBe(200);
  });

  it('ignores a forged X-Forwarded-For header (trustProxy disabled by default)', async () => {
    const namespace = `test-rl-${randomUUID()}-`;
    const app = await buildInstance(namespace, {
      authRateLimit: { login: 2, refresh: 2, windowMs: 60_000 },
    });

    expect((await login(app, { 'x-forwarded-for': '1.1.1.1' })).statusCode).toBe(200);
    expect((await login(app, { 'x-forwarded-for': '2.2.2.2' })).statusCode).toBe(200);
    // A third, distinct forged IP still lands in the same bucket as the first two.
    expect((await login(app, { 'x-forwarded-for': '3.3.3.3' })).statusCode).toBe(429);
  });

  it('still enforces a bounded limit, never unlimited, when Redis is unreachable', async () => {
    const namespace = `test-rl-${randomUUID()}-`;
    const app = await buildInstance(
      namespace,
      { authRateLimit: { login: 2, refresh: 2, windowMs: 60_000 } },
      () =>
        createRedisConnection({
          url: 'redis://127.0.0.1:1',
          connectTimeoutMs: 300,
          commandTimeoutMs: 300,
        }),
    );

    expect((await login(app)).statusCode).toBe(200);
    expect((await login(app)).statusCode).toBe(200);
    // The local fallback still caps it at the configured max -- Redis being down degrades to a
    // bounded per-process budget, never to unlimited access.
    expect((await login(app)).statusCode).toBe(429);
  });
});
