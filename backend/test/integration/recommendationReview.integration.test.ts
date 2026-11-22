import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, RECOMMENDATIONS, TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

describe.skipIf(!testDatabaseUrl)('POST /api/tickets/:id/recommendations/:id/review', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const review = async (
    as: string | null,
    ticketId: string,
    recommendationId: string,
    payload: unknown,
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/recommendations/${recommendationId}/review`,
      headers: as ? await bearer(as) : {},
      payload: payload as object,
    });
  const version = async (id: string) =>
    (await prisma.ticket.findUniqueOrThrow({ where: { id } })).version;
  const body = async (ticketId: string, over: Record<string, unknown> = {}) => ({
    decision: 'ACCEPTED',
    expectedVersion: await version(ticketId),
    ...over,
  });
  const rec = (id: string) => prisma.aiRecommendation.findUniqueOrThrow({ where: { id } });
  const reviewedEvents = (ticketId: string) =>
    prisma.ticketEvent.count({ where: { ticketId, eventType: 'AI_REVIEWED' } });
  const snapshot = async (ticketId: string, recommendationId: string) => ({
    ticket: await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } }),
    rec: await rec(recommendationId),
    events: await prisma.ticketEvent.count({ where: { ticketId } }),
  });

  const P = RECOMMENDATIONS.printerPending;

  beforeAll(async () => {
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
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

  describe('decisions', () => {
    it('ACCEPTED applies the proposal, records the reviewer and keeps the proposal immutable', async () => {
      const before = await rec(P);
      const v = await version(TICKETS.printer);
      const res = await review(USERS.hana, TICKETS.printer, P, await body(TICKETS.printer));
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        recommendationId: P,
        decision: 'ACCEPTED',
        ticket: {
          id: TICKETS.printer,
          status: 'TRIAGED',
          categoryId: CATEGORIES.hardware,
          teamId: TEAMS.hardware,
          priority: 'MEDIUM',
          version: v + 1,
        },
      });
      const after = await rec(P);
      expect(after).toMatchObject({ reviewStatus: 'ACCEPTED', reviewerId: USERS.hana });
      expect(after.reviewedAt).not.toBeNull();
      // Original AI output is untouched.
      expect(after).toMatchObject({
        proposedCategoryId: before.proposedCategoryId,
        proposedTeamId: before.proposedTeamId,
        proposedPriority: before.proposedPriority,
        suggestion: before.suggestion,
        confidence: before.confidence,
        modelVersion: before.modelVersion,
      });
      expect(await reviewedEvents(TICKETS.printer)).toBe(1);
      const types = (
        await prisma.ticketEvent.findMany({ where: { ticketId: TICKETS.printer } })
      ).map((e) => e.eventType);
      expect(types).toEqual(expect.arrayContaining(['TEAM_ASSIGNED', 'AI_REVIEWED']));
    });

    it('OVERRIDDEN applies the technician values over the proposal, with notes', async () => {
      const res = await review(
        USERS.tom,
        TICKETS.printer,
        P,
        await body(TICKETS.printer, {
          decision: 'OVERRIDDEN',
          override: { priority: 'CRITICAL', teamId: TEAMS.network, categoryId: CATEGORIES.network },
          notes: 'This is a network fault.',
        }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().data.ticket).toMatchObject({
        priority: 'CRITICAL',
        teamId: TEAMS.network,
        categoryId: CATEGORIES.network,
        status: 'TRIAGED',
      });
      expect(await rec(P)).toMatchObject({
        reviewStatus: 'OVERRIDDEN',
        reviewerId: USERS.tom,
        reviewNotes: 'This is a network fault.',
        proposedTeamId: TEAMS.hardware,
        proposedPriority: 'MEDIUM',
      });
    });

    it('OVERRIDDEN with one value keeps the rest of the proposal', async () => {
      const res = await review(
        USERS.hana,
        TICKETS.printer,
        P,
        await body(TICKETS.printer, { decision: 'OVERRIDDEN', override: { priority: 'HIGH' } }),
      );
      expect(res.json().data.ticket).toMatchObject({
        priority: 'HIGH',
        teamId: TEAMS.hardware,
        categoryId: CATEGORIES.hardware,
      });
    });

    it('REJECTED keeps every approved value and still records the decision', async () => {
      const before = await snapshot(TICKETS.printer, P);
      const res = await review(
        USERS.hana,
        TICKETS.printer,
        P,
        await body(TICKETS.printer, { decision: 'REJECTED', notes: 'Not a printer problem.' }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().data.ticket).toMatchObject({
        status: 'OPEN',
        teamId: null,
        categoryId: null,
        priority: 'UNSET',
        version: before.ticket.version,
      });
      const after = await snapshot(TICKETS.printer, P);
      expect(after.ticket).toEqual(before.ticket);
      expect(after.rec).toMatchObject({
        reviewStatus: 'REJECTED',
        reviewerId: USERS.hana,
        reviewNotes: 'Not a printer problem.',
      });
      expect(after.events).toBe(before.events + 1);
      expect(await reviewedEvents(TICKETS.printer)).toBe(1);
    });
  });

  describe('double and concurrent review', () => {
    it('a decided recommendation cannot be decided again', async () => {
      expect(
        (
          await review(
            USERS.hana,
            TICKETS.printer,
            P,
            await body(TICKETS.printer, { decision: 'REJECTED' }),
          )
        ).statusCode,
      ).toBe(200);
      const before = await snapshot(TICKETS.printer, P);
      const again = await review(USERS.hana, TICKETS.printer, P, await body(TICKETS.printer));
      expect(again.statusCode).toBe(409);
      expect(again.json().details.code).toBe('STALE_WRITE');
      expect(await snapshot(TICKETS.printer, P)).toEqual(before);
    });

    it('a recommendation reviewed earlier (seed data) is refused', async () => {
      const before = await snapshot(TICKETS.vpn, RECOMMENDATIONS.vpnAccepted);
      const res = await review(
        USERS.tara,
        TICKETS.vpn,
        RECOMMENDATIONS.vpnAccepted,
        await body(TICKETS.vpn),
      );
      expect(res.statusCode).toBe(409);
      expect(await snapshot(TICKETS.vpn, RECOMMENDATIONS.vpnAccepted)).toEqual(before);
    });

    it('two reviewers racing on the same recommendation: exactly one decision wins', async () => {
      const v = await version(TICKETS.printer);
      const [a, b] = await Promise.all([
        review(USERS.hana, TICKETS.printer, P, { decision: 'ACCEPTED', expectedVersion: v }),
        review(USERS.tom, TICKETS.printer, P, { decision: 'REJECTED', expectedVersion: v }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? 'ACCEPTED' : 'REJECTED';
      const after = await snapshot(TICKETS.printer, P);
      expect(after.rec.reviewStatus).toBe(winner);
      expect(await reviewedEvents(TICKETS.printer)).toBe(1);
      // Review status and approved routing never diverge.
      if (winner === 'REJECTED') expect(after.ticket.assignedTeamId).toBeNull();
      else expect(after.ticket.assignedTeamId).toBe(TEAMS.hardware);
    });

    it('a stale ticket version is a 409 VERSION_CONFLICT and leaves the recommendation pending', async () => {
      const before = await snapshot(TICKETS.printer, P);
      const res = await review(
        USERS.hana,
        TICKETS.printer,
        P,
        await body(TICKETS.printer, { expectedVersion: 99 }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().details).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await snapshot(TICKETS.printer, P)).toEqual(before);
      expect((await rec(P)).reviewStatus).toBe('PENDING');
    });
  });

  describe('authorization', () => {
    it('401 anonymous', async () => {
      expect((await review(null, TICKETS.printer, P, await body(TICKETS.printer))).statusCode).toBe(
        401,
      );
    });

    it('403 for the requester: employees cannot approve or reject, and nothing changes', async () => {
      const before = await snapshot(TICKETS.printer, P);
      for (const decision of ['ACCEPTED', 'REJECTED']) {
        const res = await review(
          USERS.erin,
          TICKETS.printer,
          P,
          await body(TICKETS.printer, { decision }),
        );
        expect(res.statusCode).toBe(403);
      }
      expect(await snapshot(TICKETS.printer, P)).toEqual(before);
    });

    it('404 for an employee who cannot see the ticket', async () => {
      expect(
        (await review(USERS.omar, TICKETS.printer, P, await body(TICKETS.printer))).statusCode,
      ).toBe(404);
    });

    it('404 for a technician outside the ticket team', async () => {
      // vpn belongs to Network; Hana is Hardware only.
      const res = await review(
        USERS.hana,
        TICKETS.vpn,
        RECOMMENDATIONS.vpnReanalysis,
        await body(TICKETS.vpn),
      );
      expect(res.statusCode).toBe(404);
      expect((await rec(RECOMMENDATIONS.vpnReanalysis)).reviewStatus).toBe('PENDING');
    });

    it('an administrator may review', async () => {
      const res = await review(USERS.admin, TICKETS.printer, P, await body(TICKETS.printer));
      expect(res.statusCode).toBe(200);
      expect((await rec(P)).reviewerId).toBe(USERS.admin);
    });

    it('takes the reviewer from the session, never from the body', async () => {
      const res = await review(
        USERS.hana,
        TICKETS.printer,
        P,
        await body(TICKETS.printer, { reviewerId: USERS.admin }),
      );
      expect(res.statusCode).toBe(400);
      expect((await rec(P)).reviewStatus).toBe('PENDING');
    });
  });

  describe('identifiers and validation', () => {
    it('404 when the recommendation belongs to a different ticket', async () => {
      const before = await snapshot(TICKETS.aiDown, P);
      const res = await review(USERS.hana, TICKETS.aiDown, P, await body(TICKETS.aiDown));
      expect(res.statusCode).toBe(404);
      expect(await snapshot(TICKETS.aiDown, P)).toEqual(before);
      expect((await rec(P)).reviewStatus).toBe('PENDING');
    });

    it('404 for an unknown recommendation, 400 for a malformed id', async () => {
      const payload = await body(TICKETS.printer);
      expect(
        (await review(USERS.hana, TICKETS.printer, '00000000-0000-4000-8000-000000000999', payload))
          .statusCode,
      ).toBe(404);
      expect((await review(USERS.hana, TICKETS.printer, 'nope', payload)).statusCode).toBe(400);
    });

    it.each([
      ['an unknown decision', { decision: 'MAYBE' }],
      ['a missing version', { expectedVersion: undefined }],
      ['OVERRIDDEN without values', { decision: 'OVERRIDDEN' }],
      ['OVERRIDDEN with an empty override', { decision: 'OVERRIDDEN', override: {} }],
      ['REJECTED carrying an override', { decision: 'REJECTED', override: { priority: 'LOW' } }],
      ['ACCEPTED carrying an override', { override: { priority: 'LOW' } }],
      ['an UNSET override priority', { decision: 'OVERRIDDEN', override: { priority: 'UNSET' } }],
      ['an unknown override field', { decision: 'OVERRIDDEN', override: { status: 'RESOLVED' } }],
      ['over-long notes', { notes: 'x'.repeat(2001) }],
    ])('400 for %s and changes nothing', async (_label, over) => {
      const before = await snapshot(TICKETS.printer, P);
      const res = await review(USERS.hana, TICKETS.printer, P, await body(TICKETS.printer, over));
      expect(res.statusCode).toBe(400);
      expect(await snapshot(TICKETS.printer, P)).toEqual(before);
    });
  });

  describe('stale references and atomicity', () => {
    it('accepting a proposal whose category was deactivated fails whole, then an override works', async () => {
      await prisma.ticketCategory.update({
        where: { id: CATEGORIES.hardware },
        data: { isActive: false },
      });
      const before = await snapshot(TICKETS.printer, P);
      const res = await review(USERS.hana, TICKETS.printer, P, await body(TICKETS.printer));
      expect(res.statusCode).toBe(422);
      // Rolled back together: still pending, no ticket change, no event.
      expect(await snapshot(TICKETS.printer, P)).toEqual(before);
      expect((await rec(P)).reviewStatus).toBe('PENDING');
      expect(await reviewedEvents(TICKETS.printer)).toBe(0);

      const fixed = await review(
        USERS.hana,
        TICKETS.printer,
        P,
        await body(TICKETS.printer, {
          decision: 'OVERRIDDEN',
          override: { categoryId: CATEGORIES.software },
        }),
      );
      expect(fixed.statusCode).toBe(200);
      expect(fixed.json().data.ticket.categoryId).toBe(CATEGORIES.software);
    });

    it('accepting a proposal for a deactivated team fails whole; rejecting is still possible', async () => {
      await prisma.supportTeam.update({ where: { id: TEAMS.hardware }, data: { isActive: false } });
      const res = await review(USERS.admin, TICKETS.printer, P, await body(TICKETS.printer));
      expect(res.statusCode).toBe(422);
      expect((await rec(P)).reviewStatus).toBe('PENDING');
      const rejected = await review(
        USERS.admin,
        TICKETS.printer,
        P,
        await body(TICKETS.printer, { decision: 'REJECTED' }),
      );
      expect(rejected.statusCode).toBe(200);
    });

    it('an invalid override assignee rolls the whole review back', async () => {
      const before = await snapshot(TICKETS.printer, P);
      const res = await review(
        USERS.hana,
        TICKETS.printer,
        P,
        await body(TICKETS.printer, {
          decision: 'OVERRIDDEN',
          override: { assigneeId: USERS.tara },
        }),
      );
      expect(res.statusCode).toBe(422);
      expect(await snapshot(TICKETS.printer, P)).toEqual(before);
    });

    it('a resolved ticket cannot be re-routed by accepting a recommendation', async () => {
      const created = await prisma.aiRecommendation.create({
        data: {
          ticketId: TICKETS.password,
          proposedCategoryId: CATEGORIES.software,
          proposedTeamId: TEAMS.hardware,
          proposedPriority: 'LOW',
          modelVersion: 'test',
        },
      });
      const before = await snapshot(TICKETS.password, created.id);
      const res = await review(
        USERS.tara,
        TICKETS.password,
        created.id,
        await body(TICKETS.password),
      );
      expect(res.statusCode).toBe(409);
      expect(await snapshot(TICKETS.password, created.id)).toEqual(before);
    });
  });
});
