import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import {
  ARTICLES,
  CATEGORIES,
  RECOMMENDATIONS,
  TEAMS,
  TICKETS,
  USERS,
} from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

interface Rec {
  id: string;
  confidence: number | null;
  suggestion: string | null;
  proposed: {
    category: { id: string; name: string; isActive: boolean } | null;
    team: { id: string; isActive: boolean } | null;
    priority: string | null;
  };
  review: {
    status: string;
    reviewer: { id: string } | null;
    reviewedAt: string | null;
    notes: string | null;
  };
  articles: { id: string; title: string }[];
}

describe.skipIf(!testDatabaseUrl)('GET /api/tickets/:id/recommendations', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const get = async (as: string | null, ticketId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketId}/recommendations`,
      headers: as ? await bearer(as) : {},
    });
  const recs = async (as: string, ticketId: string) =>
    (await get(as, ticketId)).json().data as Rec[];

  beforeAll(async () => {
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      logger: false,
      authRateLimit: { login: 10_000, refresh: 10_000, windowMs: 60_000 },
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

  describe('access', () => {
    it('401 anonymous', async () => {
      expect((await get(null, TICKETS.printer)).statusCode).toBe(401);
    });

    it('403 for the requester: employees never see AI output', async () => {
      const res = await get(USERS.erin, TICKETS.printer);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('spooler');
    });

    it('404 for an employee who cannot see the ticket', async () => {
      expect((await get(USERS.omar, TICKETS.printer)).statusCode).toBe(404);
    });

    it('404 for a technician outside the ticket team, 200 inside it', async () => {
      expect((await get(USERS.hana, TICKETS.vpn)).statusCode).toBe(404);
      expect((await get(USERS.tara, TICKETS.vpn)).statusCode).toBe(200);
      expect((await get(USERS.admin, TICKETS.vpn)).statusCode).toBe(200);
    });

    it('404 for unknown and malformed ticket ids', async () => {
      expect((await get(USERS.tara, '00000000-0000-4000-8000-000000000999')).statusCode).toBe(404);
      expect((await get(USERS.tara, 'nope')).statusCode).toBe(404);
    });
  });

  describe('content', () => {
    it('returns an empty list when AI never ran', async () => {
      expect(await recs(USERS.tara, TICKETS.aiDown)).toEqual([]);
    });

    it('returns the original proposal, confidence, suggestion and cited articles', async () => {
      const [r] = await recs(USERS.hana, TICKETS.printer);
      expect(r).toMatchObject({
        id: RECOMMENDATIONS.printerPending,
        confidence: 0.71,
        suggestion: 'Clear the paper jam and restart the print spooler.',
        proposed: {
          category: { id: CATEGORIES.hardware, isActive: true },
          team: { id: TEAMS.hardware, isActive: true },
          priority: 'MEDIUM',
        },
        review: { status: 'PENDING', reviewer: null, reviewedAt: null, notes: null },
      });
      expect(r!.articles.map((a) => a.id)).toEqual([ARTICLES.printer]);
    });

    it('lists the history newest first, with decisions, reviewer and notes', async () => {
      const list = await recs(USERS.tara, TICKETS.vpn);
      expect(list.map((r) => r.id)).toEqual([
        RECOMMENDATIONS.vpnReanalysis,
        RECOMMENDATIONS.vpnAccepted,
      ]);
      expect(list[0]!.review.status).toBe('PENDING');
      expect(list[1]!.review).toMatchObject({
        status: 'ACCEPTED',
        reviewer: { id: USERS.tara },
        notes: 'Matches the logs.',
      });
      expect(list[1]!.review.reviewedAt).not.toBeNull();
      // Cited articles keep their relevance order.
      expect(list[1]!.articles.map((a) => a.id)).toEqual([ARTICLES.vpn, ARTICLES.password]);
    });

    it('does not leak unpublished articles', async () => {
      await prisma.knowledgeArticle.update({
        where: { id: ARTICLES.printer },
        data: { isPublished: false },
      });
      const [r] = await recs(USERS.hana, TICKETS.printer);
      expect(r!.articles).toEqual([]);
    });

    it('flags a proposal whose category or team is no longer active', async () => {
      await prisma.ticketCategory.update({
        where: { id: CATEGORIES.hardware },
        data: { isActive: false },
      });
      await prisma.supportTeam.update({ where: { id: TEAMS.hardware }, data: { isActive: false } });
      const [r] = await recs(USERS.admin, TICKETS.printer);
      expect(r!.proposed.category).toMatchObject({ id: CATEGORIES.hardware, isActive: false });
      expect(r!.proposed.team).toMatchObject({ id: TEAMS.hardware, isActive: false });
    });

    it('shows an accepted proposal beside, not instead of, the approved ticket values', async () => {
      // The original proposal is immutable even after the technician routes the ticket elsewhere.
      await prisma.ticket.update({
        where: { id: TICKETS.vpn },
        data: { priority: 'LOW', version: { increment: 1 } },
      });
      const accepted = (await recs(USERS.tara, TICKETS.vpn)).find(
        (r) => r.id === RECOMMENDATIONS.vpnAccepted,
      );
      expect(accepted!.proposed.priority).toBe('HIGH');
    });

    it('reflects a review made through the API', async () => {
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } });
      const res = await app.inject({
        method: 'POST',
        url: `/api/tickets/${TICKETS.printer}/recommendations/${RECOMMENDATIONS.printerPending}/review`,
        headers: await bearer(USERS.hana),
        payload: { decision: 'REJECTED', expectedVersion: ticket.version, notes: 'Not a printer.' },
      });
      expect(res.statusCode).toBe(200);
      const [r] = await recs(USERS.hana, TICKETS.printer);
      expect(r!.review).toMatchObject({
        status: 'REJECTED',
        reviewer: { id: USERS.hana },
        notes: 'Not a printer.',
      });
    });
  });
});
