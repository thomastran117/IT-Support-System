import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { EMPTY_WINDOW, EXPECTED, REPORT_WINDOW, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

describe.skipIf(!testDatabaseUrl)('admin report summary API (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

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
    app = await buildApp({ env, prisma, checkDb: async () => true, logger: false });
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('matches the hand-calculated March fixture figures', async () => {
    const res = await march();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const d = res.json().data;
    expect(d.submitted).toBe(EXPECTED.q05.submitted);
    expect(d.routing).toEqual({ routed: EXPECTED.q05.routed, avgMinutes: 25 });
    expect(d.firstResponse).toEqual({ responded: 3, avgMinutes: 196.67 });
    expect(d.resolution).toEqual({ resolvedTickets: 2, avgHours: 16 });
    expect(d.aiAccuracy).toEqual({
      labelledTickets: 5,
      withRecommendation: 4,
      correct: 2,
      accuracyPct: 40,
    });
    expect(d.aiAcceptance).toEqual({ reviewed: 4, accepted: 2, acceptancePct: 50 });
    expect(d.categories).toEqual(EXPECTED.q09);
    expect(d.units.rates).toBe('percent');
  });

  it('zero-fills the daily buckets across the whole window', async () => {
    const days = (await march()).json().data.dailyIntake as {
      date: string;
      submittedTickets: number;
    }[];
    expect(days).toHaveLength(31);
    expect(days[0]).toEqual({ date: '2026-03-01', submittedTickets: 1 });
    expect(days.find((x) => x.date === '2026-03-07')!.submittedTickets).toBe(0);
    for (const e of EXPECTED.q10) {
      expect(days.find((x) => x.date === e.reportDate)!.submittedTickets).toBe(e.submittedTickets);
    }
    expect(days.reduce((n, x) => n + x.submittedTickets, 0)).toBe(9);
  });

  it('uses half-open boundaries: a ticket created at the end instant is excluded', async () => {
    // afterWindow is created exactly at 2026-04-01T00:00Z.
    expect((await march()).json().data.submitted).toBe(9);
    const wider = await get(USERS.admin, REPORT_WINDOW.start, '2026-04-01T00:00:01Z');
    expect(wider.json().data.submitted).toBe(10);
  });

  it('returns zero counts and null averages for an empty window', async () => {
    const d = (await get(USERS.admin, EMPTY_WINDOW.start, EMPTY_WINDOW.end)).json().data;
    expect(d.submitted).toBe(0);
    expect(d.routing).toEqual({ routed: 0, avgMinutes: null });
    expect(d.firstResponse).toEqual({ responded: 0, avgMinutes: null });
    expect(d.resolution).toEqual({ resolvedTickets: 0, avgHours: null });
    expect(d.aiAccuracy.accuracyPct).toBeNull();
    expect(d.aiAcceptance.acceptancePct).toBeNull();
    expect(d.categories).toEqual([]);
    expect(d.dailyIntake).toHaveLength(31);
    expect(d.dailyIntake.every((x: { submittedTickets: number }) => x.submittedTickets === 0)).toBe(
      true,
    );
  });

  it('counts unrouted and reopened tickets in the denominators', async () => {
    // 9 submitted but only 6 routed: unrouted tickets stay in `submitted`. The reopened ticket is
    // excluded from resolution (resolvedTickets 2) while still counted as submitted.
    const d = (await march()).json().data;
    expect(d.submitted - d.routing.routed).toBe(3);
    expect(d.resolution.resolvedTickets).toBe(2);
  });

  it('accepts bare dates as UTC midnight', async () => {
    const d = (await get(USERS.admin, '2026-03-01', '2026-04-01')).json().data;
    expect(d.window).toEqual({
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-04-01T00:00:00.000Z',
    });
    expect(d.submitted).toBe(9);
  });

  it.each([
    ['reversed', '2026-04-01', '2026-03-01'],
    ['empty', '2026-03-01', '2026-03-01'],
    ['garbage', 'yesterday', '2026-03-01'],
    ['no offset', '2026-03-01T00:00:00', '2026-03-02T00:00:00'],
    ['impossible date', '2026-02-30', '2026-03-05'],
    ['too long', '2024-01-01', '2026-01-01'],
  ])('rejects a %s range with 400', async (_n, start, end) => {
    const res = await get(USERS.admin, start, end);
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing parameters and unknown keys', async () => {
    const h = await bearer(USERS.admin);
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/reports/summary', headers: h }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/reports/summary?start=2026-03-01&end=2026-03-02&x=1',
          headers: h,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('is ADMIN-only: 401 anonymous, 403 employee and technician', async () => {
    expect((await march(null)).statusCode).toBe(401);
    expect((await march(USERS.erin)).statusCode).toBe(403);
    expect((await march(USERS.tara)).statusCode).toBe(403);
  });

  it('exposes only aggregates: no ids, emails or ticket text', async () => {
    const text = (await march()).body;
    expect(text).not.toMatch(/@smartdesk\.test/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
