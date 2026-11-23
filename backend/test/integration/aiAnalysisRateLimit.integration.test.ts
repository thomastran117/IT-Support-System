import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test', AI_PROVIDER: 'fake' });
const tokens = new TokenService(env);

describe.skipIf(!testDatabaseUrl)('AI analysis trigger rate limit (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const build = async (extra: Partial<AppOptions> = {}) => {
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
      logger: false,
      ...extra,
    });
  };

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };

  const trigger = async (as: string, ticketId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/analysis`,
      headers: await bearer(as),
    });

  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterEach(async () => app?.close());
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('rate-limits per account, with independent budgets per account', async () => {
    await build({ aiAnalysisRateLimit: { max: 2, windowMs: 60_000 } });

    const codes: number[] = [];
    const bodies: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await trigger(USERS.admin, TICKETS.printer);
      codes.push(res.statusCode);
      bodies.push(res.json());
    }
    // The first two calls may legitimately be a fresh job (202) or "already in progress" for
    // this ticket (409, a pre-existing per-ticket rule) -- neither is this new rate limit.
    expect(codes.slice(0, 2)).not.toContain(429);
    expect(codes[2]).toBe(429);
    // Distinguishes this plugin-level 429 from the unrelated per-ticket "too many requests for
    // this ticket" business rule, which also replies 429 but with its own error code.
    expect((bodies[2] as { details?: { code?: string } }).details?.code).not.toBe(
      'ANALYSIS_RATE_LIMITED',
    );

    // A different account, on a different ticket, has its own untouched budget.
    const other = await trigger(USERS.tara, TICKETS.aiDown);
    expect(other.statusCode).not.toBe(429);
  });
});
