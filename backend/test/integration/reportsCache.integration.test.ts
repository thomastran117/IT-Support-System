import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { EMPTY_WINDOW, EXPECTED, REPORT_WINDOW, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createCountingFakeCache, type CountingCache } from './helpers/fakeCache.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

describe.skipIf(!testDatabaseUrl)('admin report caching (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;
  let cache: CountingCache;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const get = async (as: string | null, start: string, end: string) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/reports/summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      headers: as ? await bearer(as) : {},
    });
  const march = (as: string | null = USERS.admin) =>
    get(as, REPORT_WINDOW.start, REPORT_WINDOW.end);

  beforeAll(async () => {
    cache = createCountingFakeCache();
    app = await buildApp({
      env,
      prisma,
      cache,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  beforeEach(() => cache.reset());
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('serves the same figures as the uncached Q05-Q10 fixtures', async () => {
    const d = (await march()).json().data;
    expect(d.submitted).toBe(EXPECTED.q05.submitted);
    expect(d.routing).toEqual({ routed: EXPECTED.q05.routed, avgMinutes: 25 });
    expect(d.firstResponse).toEqual({ responded: 3, avgMinutes: 196.67 });
    expect(d.resolution).toEqual({ resolvedTickets: 2, avgHours: 16 });
    expect(d.categories).toEqual(EXPECTED.q09);
  });

  it('records an actual hit rate: repeat requests for the same window hit the cache', async () => {
    const before = { hits: cache.hits, misses: cache.misses };
    await march(); // first request for this exact window: necessarily all misses
    const afterFirst = { hits: cache.hits, misses: cache.misses };
    expect(afterFirst.misses).toBeGreaterThan(before.misses);

    await march();
    await march();
    const afterRepeats = { hits: cache.hits, misses: cache.misses };
    // Three more sub-queries' worth of hits, and no additional misses for this window.
    expect(afterRepeats.hits).toBeGreaterThan(afterFirst.hits);
    expect(afterRepeats.misses).toBe(afterFirst.misses);
  });

  it('does not reuse another window entry (bounded, window-scoped keys)', async () => {
    const misses = cache.misses;
    const d = (await get(USERS.admin, EMPTY_WINDOW.start, EMPTY_WINDOW.end)).json().data;
    expect(d.submitted).toBe(0);
    expect(cache.misses).toBeGreaterThan(misses); // a genuinely new key, not the March window's
  });

  it('is still ADMIN-only once the cache is warm for this window (no cross-role leak)', async () => {
    await march(); // warm the cache for this window as an admin
    expect((await march(null)).statusCode).toBe(401);
    expect((await march(USERS.erin)).statusCode).toBe(403);
    expect((await march(USERS.tara)).statusCode).toBe(403);
  });
});
