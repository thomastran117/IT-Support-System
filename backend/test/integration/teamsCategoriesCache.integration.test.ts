import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createCountingFakeCache, type CountingCache } from './helpers/fakeCache.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

describe.skipIf(!testDatabaseUrl)('team/category reference-data caching (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;
  let cache: CountingCache;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (as: string | null, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, headers: as ? await bearer(as) : {}, payload });
  const teams = (as: string | null = USERS.tara) => call(as, 'GET', '/api/teams');
  const categories = (as: string | null = USERS.tara) => call(as, 'GET', '/api/categories');
  const members = (teamId: string, as: string | null = USERS.tara) =>
    call(as, 'GET', `/api/teams/${teamId}/members`);
  const admin = (method: Method, url: string, payload?: object) =>
    call(USERS.admin, method, `/api/admin${url}`, payload);

  beforeAll(async () => {
    cache = createCountingFakeCache();
    app = await buildApp({
      env,
      prisma,
      cache,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
      logger: false,
      authRateLimit: { login: 10_000, refresh: 10_000, windowMs: 60_000 },
    });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    cache.reset();
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('caches the active teams list and invalidates it once a team is created', async () => {
    const before = (await teams()).json().data as { name: string }[];
    expect(before.some((t) => t.name === 'New Team')).toBe(false);

    const hitsBefore = cache.hits;
    await teams(); // a second read of the same, unchanged list: a cache hit
    expect(cache.hits).toBeGreaterThan(hitsBefore);

    await admin('POST', '/teams', { name: 'New Team' });
    const after = (await teams()).json().data as { name: string }[];
    expect(after.some((t) => t.name === 'New Team')).toBe(true);
  });

  it('invalidates the active teams list once a team is deactivated', async () => {
    const before = (await teams()).json().data as { id: string }[];
    expect(before.some((t) => t.id === TEAMS.network)).toBe(true);

    await admin('POST', `/teams/${TEAMS.network}/deactivate`);

    const after = (await teams()).json().data as { id: string }[];
    expect(after.some((t) => t.id === TEAMS.network)).toBe(false);
  });

  it('caches the active categories list and invalidates it on a category write', async () => {
    const before = (await categories()).json().data as unknown[];
    const hitsBefore = cache.hits;
    await categories();
    expect(cache.hits).toBeGreaterThan(hitsBefore);

    await admin('POST', '/categories', { name: 'New Category' });
    const after = (await categories()).json().data as unknown[];
    expect(after.length).toBe(before.length + 1);
  });

  it('invalidates assignable members once a member is added or removed', async () => {
    const tech = await prisma.user.create({
      data: { email: 'rl-tech@smartdesk.test', displayName: 'RL Tech', role: 'TECHNICIAN' },
    });

    const before = (await members(TEAMS.network)).json().data as { id: string }[];
    expect(before.some((m) => m.id === tech.id)).toBe(false);

    await admin('POST', `/teams/${TEAMS.network}/members`, { userId: tech.id });
    const afterAdd = (await members(TEAMS.network)).json().data as { id: string }[];
    expect(afterAdd.some((m) => m.id === tech.id)).toBe(true);

    await admin('DELETE', `/teams/${TEAMS.network}/members/${tech.id}`);
    const afterRemove = (await members(TEAMS.network)).json().data as { id: string }[];
    expect(afterRemove.some((m) => m.id === tech.id)).toBe(false);
  });

  it('is still staff-only once the cache is warm (no cross-role leak)', async () => {
    await teams(USERS.tara); // warm the cache as a technician
    expect((await teams(null)).statusCode).toBe(401);
    expect((await teams(USERS.erin)).statusCode).toBe(403);
  });
});
