import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

describe.skipIf(!testDatabaseUrl)('POST /api/tickets/:id/routing (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const route = async (as: string | null, ticketId: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/routing`,
      headers: as ? await bearer(as) : {},
      payload: payload as object,
    });
  const version = async (id: string) =>
    (await prisma.ticket.findUniqueOrThrow({ where: { id } })).version;
  const events = async (id: string) =>
    (
      await prisma.ticketEvent.findMany({ where: { ticketId: id }, orderBy: { occurredAt: 'asc' } })
    ).map((e) => e.eventType);
  const body = async (id: string, over: Record<string, unknown> = {}) => ({
    categoryId: CATEGORIES.hardware,
    priority: 'HIGH',
    teamId: TEAMS.hardware,
    expectedVersion: await version(id),
    ...over,
  });
  const snapshot = async (id: string) => ({
    ticket: await prisma.ticket.findUniqueOrThrow({ where: { id } }),
    events: await events(id),
  });

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

  describe('manual triage', () => {
    it('triages an OPEN unassigned ticket and records TEAM_ASSIGNED atomically', async () => {
      const before = await version(TICKETS.printer);
      const res = await route(USERS.hana, TICKETS.printer, await body(TICKETS.printer));
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        id: TICKETS.printer,
        status: 'TRIAGED',
        priority: 'HIGH',
        categoryId: CATEGORIES.hardware,
        teamId: TEAMS.hardware,
        assigneeId: null,
        version: before + 1,
      });
      const log = await events(TICKETS.printer);
      expect(log).toEqual(
        expect.arrayContaining(['CATEGORY_UPDATED', 'PRIORITY_UPDATED', 'TEAM_ASSIGNED']),
      );
      expect(log).not.toContain('TEAM_REASSIGNED');
      const row = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } });
      expect(row.status).toBe('TRIAGED');
    });

    it('works when AI never ran, assigning a team member in the same request', async () => {
      expect(await prisma.aiRecommendation.count({ where: { ticketId: TICKETS.aiDown } })).toBe(0);
      const res = await route(
        USERS.tara,
        TICKETS.aiDown,
        await body(TICKETS.aiDown, {
          teamId: TEAMS.network,
          categoryId: CATEGORIES.network,
          priority: 'CRITICAL',
          assigneeId: USERS.tom,
        }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ status: 'TRIAGED', assigneeId: USERS.tom });
      expect(await events(TICKETS.aiDown)).toEqual(
        expect.arrayContaining(['TEAM_ASSIGNED', 'ASSIGNEE_UPDATED']),
      );
    });

    it('leaves a pending AI recommendation untouched', async () => {
      const before = await prisma.aiRecommendation.findMany({
        where: { ticketId: TICKETS.printer },
      });
      expect(before.length).toBeGreaterThan(0);
      await route(USERS.hana, TICKETS.printer, await body(TICKETS.printer));
      const after = await prisma.aiRecommendation.findMany({
        where: { ticketId: TICKETS.printer },
      });
      expect(after).toEqual(before);
    });

    it('lets an administrator triage any ticket', async () => {
      const res = await route(USERS.admin, TICKETS.token, await body(TICKETS.token));
      expect(res.statusCode).toBe(200);
    });
  });

  describe('reassignment', () => {
    it('records TEAM_REASSIGNED (not TEAM_ASSIGNED) for a later team change', async () => {
      // license: Network, assigned to Tom. Move to Hardware and hand it to Hana.
      const res = await route(
        USERS.tara,
        TICKETS.license,
        await body(TICKETS.license, { assigneeId: USERS.hana }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ teamId: TEAMS.hardware, assigneeId: USERS.hana });
      const log = await events(TICKETS.license);
      expect(log).toContain('TEAM_REASSIGNED');
      const last = await prisma.ticketEvent.findFirstOrThrow({
        where: { ticketId: TICKETS.license, eventType: 'TEAM_REASSIGNED' },
        orderBy: { occurredAt: 'desc' },
      });
      expect(last.details).toMatchObject({ from: TEAMS.network, to: TEAMS.hardware });
    });

    it('clears the assignee on a team change unless a new one is given', async () => {
      const res = await route(USERS.tara, TICKETS.license, await body(TICKETS.license));
      expect(res.statusCode).toBe(200);
      expect(res.json().data.assigneeId).toBeNull();
    });

    it('keeps the assignee when the team is unchanged and assigneeId is omitted, clears on null', async () => {
      const keep = await route(
        USERS.tara,
        TICKETS.license,
        await body(TICKETS.license, { teamId: TEAMS.network, priority: 'CRITICAL' }),
      );
      expect(keep.json().data).toMatchObject({ priority: 'CRITICAL', assigneeId: USERS.tom });
      const cleared = await route(
        USERS.tara,
        TICKETS.license,
        await body(TICKETS.license, {
          teamId: TEAMS.network,
          priority: 'CRITICAL',
          assigneeId: null,
        }),
      );
      expect(cleared.json().data.assigneeId).toBeNull();
    });

    it('is idempotent when nothing changes: no new version or events', async () => {
      const t = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.license } });
      const before = await snapshot(TICKETS.license);
      const res = await route(USERS.tara, TICKETS.license, {
        categoryId: t.categoryId,
        priority: t.priority,
        teamId: t.assignedTeamId,
        expectedVersion: t.version,
      });
      expect(res.statusCode).toBe(200);
      expect(await snapshot(TICKETS.license)).toEqual(before);
    });
  });

  describe('authorization', () => {
    it('401 anonymous', async () => {
      expect((await route(null, TICKETS.printer, await body(TICKETS.printer))).statusCode).toBe(
        401,
      );
    });

    it('403 for the requester, who can read but never approve routing', async () => {
      const before = await snapshot(TICKETS.printer);
      const res = await route(USERS.erin, TICKETS.printer, await body(TICKETS.printer));
      expect(res.statusCode).toBe(403);
      expect(await snapshot(TICKETS.printer)).toEqual(before);
    });

    it('404 for an employee who cannot see the ticket', async () => {
      expect(
        (await route(USERS.omar, TICKETS.printer, await body(TICKETS.printer))).statusCode,
      ).toBe(404);
    });

    it('404 for a technician outside the ticket team, and nothing changes', async () => {
      const before = await snapshot(TICKETS.license);
      const res = await route(USERS.hana, TICKETS.license, await body(TICKETS.license));
      expect(res.statusCode).toBe(404);
      expect(await snapshot(TICKETS.license)).toEqual(before);
    });

    it('404 for unknown or malformed ticket ids', async () => {
      const payload = await body(TICKETS.printer);
      expect(
        (await route(USERS.tara, '00000000-0000-4000-8000-000000000000', payload)).statusCode,
      ).toBe(404);
      expect((await route(USERS.tara, 'nope', payload)).statusCode).toBe(404);
    });

    it('rejects an employee smuggling routing fields through ticket creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: await bearer(USERS.erin),
        payload: { title: 't', description: 'd', teamId: TEAMS.network, priority: 'HIGH' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('validation and conflicts', () => {
    it.each([
      ['missing expectedVersion', { expectedVersion: undefined }],
      ['version 0', { expectedVersion: 0 }],
      ['priority UNSET', { priority: 'UNSET' }],
      ['unknown priority', { priority: 'URGENT' }],
      ['non-uuid category', { categoryId: 'x' }],
      ['unknown field', { status: 'RESOLVED' }],
      ['requester override', { requesterId: USERS.omar }],
    ])('400 for %s and changes nothing', async (_label, over) => {
      const before = await snapshot(TICKETS.printer);
      const res = await route(USERS.hana, TICKETS.printer, await body(TICKETS.printer, over));
      expect(res.statusCode).toBe(400);
      expect(await snapshot(TICKETS.printer)).toEqual(before);
    });

    it('409 VERSION_CONFLICT for a stale version, without partial updates', async () => {
      const before = await snapshot(TICKETS.printer);
      const stale = before.ticket.version - 1 || 99;
      const res = await route(
        USERS.hana,
        TICKETS.printer,
        await body(TICKETS.printer, { expectedVersion: stale }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().details).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentVersion: before.ticket.version,
      });
      expect(await snapshot(TICKETS.printer)).toEqual(before);
    });

    it('lets exactly one of two concurrent approvals win', async () => {
      const v = await version(TICKETS.printer);
      const mk = (team: string, category: string, as: string) =>
        route(as, TICKETS.printer, {
          categoryId: category,
          priority: 'HIGH',
          teamId: team,
          expectedVersion: v,
        });
      const [a, b] = await Promise.all([
        mk(TEAMS.hardware, CATEGORIES.hardware, USERS.tom),
        mk(TEAMS.network, CATEGORIES.network, USERS.tom),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      expect(
        (await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } })).assignedTeamId,
      ).toBe(winner.json().data.teamId);
      expect(await version(TICKETS.printer)).toBe(v + 1);
      expect((await events(TICKETS.printer)).filter((e) => e === 'TEAM_ASSIGNED')).toHaveLength(1);
    });

    it.each([
      ['an inactive category', { categoryId: CATEGORIES.legacy }],
      ['an inactive team', { teamId: TEAMS.legacy }],
      ['an unknown team', { teamId: '00000000-0000-4000-8000-000000000000' }],
      ['an assignee outside the team', { assigneeId: USERS.tara }],
      ['an employee as assignee', { assigneeId: USERS.erin }],
      ['an inactive technician as assignee', { assigneeId: USERS.ingrid }],
    ])('rejects %s with nothing partially applied', async (_label, over) => {
      const before = await snapshot(TICKETS.printer);
      const res = await route(USERS.hana, TICKETS.printer, await body(TICKETS.printer, over));
      expect([409, 422]).toContain(res.statusCode);
      expect(await snapshot(TICKETS.printer)).toEqual(before);
    });

    it('refuses to re-route a resolved ticket', async () => {
      const before = await snapshot(TICKETS.password);
      const res = await route(
        USERS.tara,
        TICKETS.password,
        await body(TICKETS.password, { teamId: TEAMS.network }),
      );
      expect(res.statusCode).toBe(409);
      expect(await snapshot(TICKETS.password)).toEqual(before);
    });
  });
});
