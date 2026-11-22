import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import {
  CATEGORIES,
  EMPTY_WINDOW,
  REPORT_WINDOW,
  TICKETS,
  USERS,
  uuid,
} from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

describe.skipIf(!testDatabaseUrl)('independent AI evaluation (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (
    as: string | null,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
  ) => app.inject({ method, url, headers: as ? await bearer(as) : {}, payload });
  const labelUrl = (ticketId: string) => `/api/admin/tickets/${ticketId}/classification-label`;
  const report = (as: string | null, start = REPORT_WINDOW.start, end = REPORT_WINDOW.end) =>
    call(
      as,
      'GET',
      `/api/admin/reports/ai-evaluation?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    );
  const addRecommendation = (
    ticketId: string,
    over: { proposedCategoryId: string | null; createdAt: string; modelVersion?: string },
  ) =>
    prisma.aiRecommendation.create({
      data: {
        ticketId,
        proposedCategoryId: over.proposedCategoryId,
        modelVersion: over.modelVersion ?? 'fixture-model-1',
        createdAt: new Date(over.createdAt),
      },
    });

  beforeAll(async () => {
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  describe('report', () => {
    it('matches the seeded fixtures with explicit denominators, per model and as a confusion summary', async () => {
      const res = await report(USERS.admin);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const d = res.json().data;
      expect(d.overall).toEqual({
        labelledTickets: 5,
        withRecommendation: 4,
        withoutRecommendation: 1,
        correct: 2,
        accuracyPct: 40,
      });
      expect(d.acceptance).toEqual({ reviewed: 4, accepted: 2, acceptancePct: 50 });
      // fixture-model-2 only produced a later, unreviewed recommendation for an already-covered ticket.
      expect(d.byModel).toEqual([
        {
          modelVersion: 'fixture-model-1',
          labelledTickets: 4,
          correct: 2,
          accuracyPct: 50,
          reviewed: 4,
          accepted: 2,
          acceptancePct: 50,
        },
      ]);
      expect(d.confusion).toEqual([
        {
          referenceCategory: 'Access/Accounts',
          predictedCategory: 'Access/Accounts',
          ticketCount: 1,
        },
        { referenceCategory: 'Access/Accounts', predictedCategory: null, ticketCount: 1 },
        { referenceCategory: 'Hardware', predictedCategory: 'Software', ticketCount: 1 },
        { referenceCategory: 'Network/VPN', predictedCategory: 'Network/VPN', ticketCount: 1 },
        { referenceCategory: 'Software', predictedCategory: 'Hardware', ticketCount: 1 },
      ]);
    });

    it('a missing or invalid prediction lowers accuracy instead of leaving the denominator', async () => {
      await call(USERS.admin, 'PUT', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.hardware,
      });
      // The only recommendation proposes no category (unusable).
      await addRecommendation(TICKETS.token, {
        proposedCategoryId: null,
        createdAt: '2026-03-06T12:00:00Z',
      });
      const d = (await report(USERS.admin)).json().data;
      expect(d.overall).toMatchObject({
        labelledTickets: 6,
        withRecommendation: 4,
        withoutRecommendation: 2,
        correct: 2,
        accuracyPct: 33.33,
      });
    });

    it('uses the first VALID recommendation, skipping an earlier unusable one', async () => {
      await call(USERS.admin, 'PUT', labelUrl(TICKETS.printer), {
        referenceCategoryId: CATEGORIES.hardware,
      });
      // printer's only valid recommendation proposes Hardware (correct); an earlier unusable one is skipped.
      await addRecommendation(TICKETS.printer, {
        proposedCategoryId: null,
        createdAt: '2026-03-02T08:00:00Z',
      });
      const d = (await report(USERS.admin)).json().data;
      expect(d.overall).toMatchObject({ labelledTickets: 6, withRecommendation: 5, correct: 3 });
    });

    it('groups by model version using the model that produced the first valid recommendation', async () => {
      await call(USERS.admin, 'PUT', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.software,
      });
      await addRecommendation(TICKETS.token, {
        proposedCategoryId: CATEGORIES.software,
        createdAt: '2026-03-06T12:00:00Z',
        modelVersion: 'fixture-model-9',
      });
      const d = (await report(USERS.admin)).json().data;
      const m9 = d.byModel.find(
        (m: { modelVersion: string }) => m.modelVersion === 'fixture-model-9',
      );
      expect(m9).toMatchObject({ labelledTickets: 1, correct: 1, accuracyPct: 100, reviewed: 0 });
      expect(m9.acceptancePct).toBeNull();
    });

    it('returns zero counts and null rates when nothing is labelled in the window', async () => {
      const d = (await report(USERS.admin, EMPTY_WINDOW.start, EMPTY_WINDOW.end)).json().data;
      expect(d.overall).toEqual({
        labelledTickets: 0,
        withRecommendation: 0,
        withoutRecommendation: 0,
        correct: 0,
        accuracyPct: null,
      });
      expect(d.acceptance).toEqual({ reviewed: 0, accepted: 0, acceptancePct: null });
      expect(d.byModel).toEqual([]);
      expect(d.confusion).toEqual([]);
    });

    it('rejects invalid ranges and exposes aggregates only', async () => {
      expect((await report(USERS.admin, '2026-04-01', '2026-03-01')).statusCode).toBe(400);
      const body = (await report(USERS.admin)).body;
      expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(body).not.toMatch(/@smartdesk\.test/);
    });

    it('is ADMIN-only', async () => {
      expect((await report(null)).statusCode).toBe(401);
      expect((await report(USERS.erin)).statusCode).toBe(403);
      expect((await report(USERS.tara)).statusCode).toBe(403);
    });
  });

  describe('labels', () => {
    const labelCount = () => prisma.classificationLabel.count();

    it('an administrator creates a label; the labeller and time come from the session', async () => {
      const res = await call(USERS.admin, 'POST', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.network,
      });
      expect(res.statusCode).toBe(201);
      const d = res.json().data;
      expect(d.ticketId).toBe(TICKETS.token);
      expect(d.referenceCategory.name).toBe('Network/VPN');
      expect(d.labelledBy).toEqual({ id: USERS.admin, displayName: 'Alex Admin' });
      const row = await prisma.classificationLabel.findUniqueOrThrow({
        where: { ticketId: TICKETS.token },
      });
      expect(row.labelledBy).toBe(USERS.admin);
    });

    it('cannot be told who labelled, and never touches AI output or the approved category', async () => {
      const before = {
        recs: await prisma.aiRecommendation.findMany({ orderBy: { id: 'asc' } }),
        ticket: await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.token } }),
      };
      const spoof = await call(USERS.admin, 'POST', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.network,
        labelledBy: USERS.erin,
      });
      expect(spoof.statusCode).toBe(400);
      expect(await labelCount()).toBe(5);

      await call(USERS.admin, 'PUT', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.network,
      });
      expect(await prisma.aiRecommendation.findMany({ orderBy: { id: 'asc' } })).toEqual(
        before.recs,
      );
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.token } });
      expect(after.categoryId).toBe(before.ticket.categoryId);
      expect(after.version).toBe(before.ticket.version);
    });

    it('POST does not overwrite; PUT replaces and records the new editor and time', async () => {
      const other = await prisma.user.create({
        data: { email: 'second.admin@smartdesk.test', displayName: 'Second Admin', role: 'ADMIN' },
      });
      await call(USERS.admin, 'POST', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.network,
      });
      const dup = await call(USERS.admin, 'POST', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.software,
      });
      expect(dup.statusCode).toBe(409);
      expect(
        (await prisma.classificationLabel.findUniqueOrThrow({ where: { ticketId: TICKETS.token } }))
          .referenceCategoryId,
      ).toBe(CATEGORIES.network);

      const put = await call(other.id, 'PUT', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.software,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().data.referenceCategory.name).toBe('Software');
      expect(put.json().data.labelledBy.id).toBe(other.id);
      expect(await labelCount()).toBe(6);
      const got = await call(USERS.admin, 'GET', labelUrl(TICKETS.token));
      expect(got.json().data.referenceCategory.id).toBe(CATEGORIES.software);
    });

    it('validates the ticket and the category', async () => {
      const unknownTicket = uuid('ticket', 999);
      expect(
        (
          await call(USERS.admin, 'PUT', labelUrl(unknownTicket), {
            referenceCategoryId: CATEGORIES.network,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await call(USERS.admin, 'PUT', labelUrl(TICKETS.token), {
            referenceCategoryId: uuid('category', 999),
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await call(USERS.admin, 'PUT', labelUrl(TICKETS.token), {
            referenceCategoryId: CATEGORIES.legacy,
          })
        ).statusCode,
      ).toBe(422);
      expect((await call(USERS.admin, 'PUT', labelUrl('not-a-uuid'), {})).statusCode).toBe(400);
      expect((await call(USERS.admin, 'PUT', labelUrl(TICKETS.token), {})).statusCode).toBe(400);
      expect((await call(USERS.admin, 'GET', labelUrl(TICKETS.token))).statusCode).toBe(404);
      expect(await labelCount()).toBe(5);
    });

    it('refuses everyone but administrators without changing data', async () => {
      const body = { referenceCategoryId: CATEGORIES.network };
      for (const as of [null, USERS.erin, USERS.tara]) {
        const expected = as === null ? 401 : 403;
        expect((await call(as, 'POST', labelUrl(TICKETS.token), body)).statusCode).toBe(expected);
        expect((await call(as, 'PUT', labelUrl(TICKETS.vpn), body)).statusCode).toBe(expected);
        expect((await call(as, 'GET', labelUrl(TICKETS.vpn))).statusCode).toBe(expected);
        expect((await call(as, 'GET', '/api/admin/classification-labels')).statusCode).toBe(
          expected,
        );
      }
      expect(await labelCount()).toBe(5);
      expect(
        (await prisma.classificationLabel.findUniqueOrThrow({ where: { ticketId: TICKETS.vpn } }))
          .referenceCategoryId,
      ).toBe(CATEGORIES.network);
    });

    it('lists labelled tickets with who labelled them, newest first', async () => {
      await call(USERS.admin, 'PUT', labelUrl(TICKETS.token), {
        referenceCategoryId: CATEGORIES.hardware,
      });
      const res = await call(USERS.admin, 'GET', '/api/admin/classification-labels?limit=2');
      const d = res.json().data;
      expect(d.total).toBe(6);
      expect(d.items).toHaveLength(2);
      expect(d.items[0].ticketId).toBe(TICKETS.token);
      expect(d.items[0].labelledBy.displayName).toBe('Alex Admin');
    });
  });
});
