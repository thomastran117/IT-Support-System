import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRedisCache } from '../../src/cache/redisCache.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

/**
 * SD-073's core correctness claim: PostgreSQL stays authoritative no matter what Redis is doing.
 * This points the cache at a genuinely unreachable host (not "disabled" -- actually down) so every
 * cache read and write on every request fails, and proves the write path (ticket creation, its
 * audit trail) and the read path (reference data) both still work correctly. Unlike the real-Redis
 * tests in cache.integration.test.ts, this only needs PostgreSQL, so it runs in every CI pass.
 */
describe.skipIf(!testDatabaseUrl)('durability during a cache outage (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };

  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'unavailable' as const,
      logger: false,
      cache: createRedisCache({
        url: 'redis://127.0.0.1:1',
        connectTimeoutMs: 300,
        commandTimeoutMs: 300,
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('creates a ticket and its full audit trail even though the cache is entirely unreachable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: await bearer(USERS.erin),
      payload: { title: 'Outage smoke test', description: 'Written while Redis is unreachable.' },
    });
    expect(res.statusCode).toBe(201);
    const ticketId = (res.json().data as { id: string }).id;

    // Read the committed rows directly -- not through the app -- so this proves what actually
    // landed in PostgreSQL, independent of any cache-related code path.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.title).toBe('Outage smoke test');

    const events = await prisma.ticketEvent.findMany({ where: { ticketId } });
    expect(events.some((e) => e.eventType === 'CREATED')).toBe(true);
  });

  it('still serves reference-data and report reads by falling through to PostgreSQL', async () => {
    const teamsRes = await app.inject({
      method: 'GET',
      url: '/api/teams',
      headers: await bearer(USERS.tara),
    });
    expect(teamsRes.statusCode).toBe(200);
    expect((teamsRes.json().data as unknown[]).length).toBeGreaterThan(0);

    const reportsRes = await app.inject({
      method: 'GET',
      url: '/api/admin/reports/summary?start=2026-03-01T00:00:00Z&end=2026-04-01T00:00:00Z',
      headers: await bearer(USERS.admin),
    });
    expect(reportsRes.statusCode).toBe(200);
  });
});
