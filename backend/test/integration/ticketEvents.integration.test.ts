import type { FastifyInstance } from 'fastify';
import type { TicketTimelineEntry } from '@smartdesk/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TICKET_EVENT_TYPES } from '../../src/domain/ticketEvents.js';
import { CATEGORIES, TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { appendEvent } from '../../src/db/repositories/ticketEvents.js';
import {
  approveRouting,
  reviewRecommendation,
  submitTicket,
  transitionTicket,
} from '../../src/db/services/ticketService.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);
const SECRET = 'INTERNAL-ONLY-secret-note';

describe.skipIf(!testDatabaseUrl)('ticket event timeline (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (
    as: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => {
    const res = await app.inject({ method, url, headers: as ? await bearer(as) : {}, payload });
    return { status: res.statusCode, body: res.json(), raw: res.body };
  };
  const timeline = async (as: string, id: string): Promise<TicketTimelineEntry[]> => {
    const r = await call(as, 'GET', `/api/tickets/${id}/events`);
    expect(r.status).toBe(200);
    return r.body.data;
  };
  const rows = (ticketId: string) =>
    prisma.ticketEvent.findMany({
      where: { ticketId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
  const types = async (ticketId: string) => (await rows(ticketId)).map((e) => e.eventType);
  const fresh = async () =>
    (await submitTicket(prisma, { requesterId: USERS.erin, title: 'VPN drops', description: 'd' }))
      .ticket;

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

  it('lists exactly the event types the database accepts', async () => {
    const [{ def }] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_ticket_events_type'`;
    const inDb = [...def!.matchAll(/'([A-Z_]+)'::/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual([...TICKET_EVENT_TYPES].sort());
  });

  describe('audit coverage: every material change leaves its event, in order, by the right actor', () => {
    it('records the whole lifecycle with correct actors, details and order', async () => {
      const t = await fresh();
      const tara = USERS.tara;
      const cat = CATEGORIES.network;

      // Routing: category, priority, team, status, in that order, by the technician.
      await approveRouting(prisma, {
        ticketId: t.id,
        actorId: tara,
        categoryId: cat,
        priority: 'HIGH',
        teamId: TEAMS.network,
      });
      // Assignee, then a move to another team (TEAM_REASSIGNED) with a new assignee.
      await approveRouting(prisma, { ticketId: t.id, actorId: tara, assigneeId: tara });
      await approveRouting(prisma, {
        ticketId: t.id,
        actorId: USERS.admin,
        teamId: TEAMS.hardware,
        assigneeId: USERS.hana,
      });
      // A public reply, an internal note, then the workflow.
      await call(USERS.hana, 'POST', `/api/tickets/${t.id}/comments`, { body: 'Looking' });
      await call(USERS.hana, 'POST', `/api/tickets/${t.id}/comments`, {
        body: SECRET,
        isInternal: true,
      });
      for (const [to, extra] of [
        ['IN_PROGRESS', {}],
        ['RESOLVED', { resolutionSummary: 'Replaced cable' }],
        ['CLOSED', {}],
      ] as const) {
        const cur = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
        const r = await call(USERS.hana, 'POST', `/api/tickets/${t.id}/transitions`, {
          to,
          expectedVersion: cur.version,
          ...extra,
        });
        expect(r.status).toBe(200);
      }
      await transitionTicket(prisma, { ticketId: t.id, actorId: USERS.erin, to: 'OPEN' });
      // An AI recommendation reviewed by a technician.
      const rec = await prisma.aiRecommendation.create({
        data: { ticketId: t.id, proposedPriority: 'LOW', modelVersion: 'test-1' },
      });
      await reviewRecommendation(prisma, {
        recommendationId: rec.id,
        reviewerId: USERS.hana,
        decision: 'REJECTED',
      });

      expect(await types(t.id)).toEqual([
        'CREATED',
        'CATEGORY_UPDATED',
        'PRIORITY_UPDATED',
        'TEAM_ASSIGNED',
        'STATUS_CHANGED', // OPEN -> TRIAGED, when routing completed
        'ASSIGNEE_UPDATED',
        'TEAM_REASSIGNED',
        'ASSIGNEE_UPDATED',
        'COMMENT_ADDED',
        'COMMENT_ADDED',
        'STATUS_CHANGED', // IN_PROGRESS
        'RESOLVED',
        'STATUS_CHANGED', // CLOSED
        'REOPENED',
        'AI_REVIEWED',
      ]);
      // Every type the product writes today was exercised.
      expect(new Set(await types(t.id))).toEqual(new Set(TICKET_EVENT_TYPES));

      const events = await rows(t.id);
      const by = (type: string, n = 0) => events.filter((e) => e.eventType === type)[n]!;
      expect(by('CREATED')).toMatchObject({ actorId: USERS.erin, details: {} });
      expect(by('CATEGORY_UPDATED')).toMatchObject({
        actorId: tara,
        details: { from: null, to: cat },
      });
      expect(by('PRIORITY_UPDATED').details).toEqual({ from: 'UNSET', to: 'HIGH' });
      expect(by('TEAM_ASSIGNED').details).toEqual({ from: null, to: TEAMS.network });
      expect(by('STATUS_CHANGED').details).toEqual({ from: 'OPEN', to: 'TRIAGED' });
      expect(by('TEAM_REASSIGNED')).toMatchObject({
        actorId: USERS.admin,
        details: { from: TEAMS.network, to: TEAMS.hardware },
      });
      expect(by('RESOLVED')).toMatchObject({
        actorId: USERS.hana,
        details: { from: 'IN_PROGRESS' },
      });
      expect(by('REOPENED')).toMatchObject({ actorId: USERS.erin, details: { from: 'CLOSED' } });
      expect(by('AI_REVIEWED')).toMatchObject({
        actorId: USERS.hana,
        details: { recommendationId: rec.id, decision: 'REJECTED' },
      });
      // Times never go backwards, even for events written in one transaction.
      const stamps = events.map((e) => e.occurredAt.getTime());
      expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
      // No comment text or description ever reached the audit trail.
      const dump = JSON.stringify(events.map((e) => e.details));
      expect(dump).not.toContain(SECRET);
      expect(dump).not.toContain('Replaced cable');
      expect(dump).not.toContain('VPN drops');
    });

    it('writes nothing for a mutation that changes nothing', async () => {
      const t = await fresh();
      await approveRouting(prisma, { ticketId: t.id, actorId: USERS.tara, priority: 'LOW' });
      const before = (await rows(t.id)).length;
      await approveRouting(prisma, { ticketId: t.id, actorId: USERS.tara, priority: 'LOW' });
      expect((await rows(t.id)).length).toBe(before);
    });
  });

  describe('atomicity: no orphan event, no mutation without its event', () => {
    const withFailingEvents = async (when: string, run: () => Promise<void>) => {
      await prisma.$executeRawUnsafe(
        "CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced failure'; END $fn$",
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER trg_fail_event BEFORE INSERT ON ticket_events FOR EACH ROW ${when} EXECUTE FUNCTION fail_event()`,
      );
      try {
        await run();
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER trg_fail_event ON ticket_events');
        await prisma.$executeRawUnsafe('DROP FUNCTION fail_event()');
      }
    };

    it('rolls a routing change back when its event cannot be written', async () => {
      const t = await fresh();
      const before = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      await withFailingEvents("WHEN (NEW.event_type = 'PRIORITY_UPDATED')", async () => {
        await expect(
          approveRouting(prisma, {
            ticketId: t.id,
            actorId: USERS.tara,
            categoryId: CATEGORIES.network,
            priority: 'HIGH',
            teamId: TEAMS.network,
          }),
        ).rejects.toBeTruthy();
      });
      expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toEqual(before);
      // The earlier CATEGORY_UPDATED in the same transaction was rolled back too.
      expect(await types(t.id)).toEqual(['CREATED']);
    });

    it('rolls an AI review back, leaving the recommendation pending', async () => {
      const t = await fresh();
      const rec = await prisma.aiRecommendation.create({
        data: {
          ticketId: t.id,
          proposedCategoryId: CATEGORIES.network,
          proposedTeamId: TEAMS.network,
          proposedPriority: 'HIGH',
          modelVersion: 'test-1',
        },
      });
      await withFailingEvents("WHEN (NEW.event_type = 'AI_REVIEWED')", async () => {
        await expect(
          reviewRecommendation(prisma, {
            recommendationId: rec.id,
            reviewerId: USERS.tara,
            decision: 'ACCEPTED',
          }),
        ).rejects.toBeTruthy();
      });
      expect(
        (await prisma.aiRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).reviewStatus,
      ).toBe('PENDING');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe(
        'UNSET',
      );
      expect(await types(t.id)).toEqual(['CREATED']);
    });

    it('leaves no event behind when the mutation itself is rejected', async () => {
      const t = await fresh();
      await expect(
        transitionTicket(prisma, { ticketId: t.id, actorId: USERS.tara, to: 'TRIAGED' }),
      ).rejects.toMatchObject({ code: 'PREREQUISITE_FAILED' });
      expect(await types(t.id)).toEqual(['CREATED']);
    });
  });

  describe('sanitization on write', () => {
    it('stores only allow-listed details, whatever the caller passes', async () => {
      const t = await fresh();
      await appendEvent(prisma, {
        ticketId: t.id,
        actorId: USERS.tara,
        type: 'STATUS_CHANGED',
        details: {
          from: 'OPEN',
          to: 'TRIAGED',
          password: 'hunter2',
          token: 'eyJhbGciOi',
          description: 'the entire raw ticket body',
          body: SECRET,
        },
      });
      const [event] = (await rows(t.id)).slice(-1);
      expect(event!.details).toEqual({ from: 'OPEN', to: 'TRIAGED' });
    });

    it('still sanitizes legacy rows when they are read', async () => {
      const t = await fresh();
      await prisma.$executeRaw`
        INSERT INTO ticket_events (ticket_id, actor_id, event_type, details)
        VALUES (${t.id}::uuid, ${USERS.tara}::uuid, 'STATUS_CHANGED',
                '{"from":"OPEN","to":"TRIAGED","password":"hunter2","note":"private"}'::jsonb)`;
      const staff = await call(USERS.tara, 'GET', `/api/tickets/${t.id}/events`);
      expect(staff.raw).not.toContain('hunter2');
      expect(staff.raw).not.toContain('private');
    });
  });

  describe('GET /api/tickets/:id/events', () => {
    let ticketId: string;
    beforeEach(async () => {
      ticketId = (await fresh()).id;
      await approveRouting(prisma, {
        ticketId,
        actorId: USERS.tara,
        categoryId: CATEGORIES.network,
        priority: 'HIGH',
        teamId: TEAMS.network,
        assigneeId: USERS.tara,
      });
      await call(USERS.tara, 'POST', `/api/tickets/${ticketId}/comments`, {
        body: SECRET,
        isInternal: true,
      });
      await appendEvent(prisma, {
        ticketId,
        actorId: null,
        type: 'STATUS_CHANGED',
        details: { from: 'TRIAGED', to: 'TRIAGED' },
      });
    });

    it('gives staff in scope every event, with actors and a system action as null', async () => {
      for (const staff of [USERS.tara, USERS.tom, USERS.admin]) {
        const t = await timeline(staff, ticketId);
        expect(t.map((e) => e.type)).toEqual(await types(ticketId));
        expect(t[0]).toMatchObject({ type: 'CREATED', actor: { id: USERS.erin } });
        expect(t.some((e) => e.type === 'ASSIGNEE_UPDATED')).toBe(true);
        expect(t.some((e) => e.type === 'COMMENT_ADDED')).toBe(true);
        expect(t.at(-1)).toMatchObject({ type: 'STATUS_CHANGED', actor: null });
      }
    });

    it('gives the requester a reduced view: no internal types, no actors, no ids or text', async () => {
      const r = await call(USERS.erin, 'GET', `/api/tickets/${ticketId}/events`);
      expect(r.status).toBe(200);
      const t: TicketTimelineEntry[] = r.body.data;
      expect(t.map((e) => e.type)).toEqual([
        'CREATED',
        'CATEGORY_UPDATED',
        'PRIORITY_UPDATED',
        'TEAM_ASSIGNED',
        'STATUS_CHANGED',
        'STATUS_CHANGED',
      ]);
      expect(t.every((e) => e.actor === null)).toBe(true);
      expect(t.find((e) => e.type === 'PRIORITY_UPDATED')!.details).toEqual({
        from: 'UNSET',
        to: 'HIGH',
      });
      expect(t.find((e) => e.type === 'TEAM_ASSIGNED')!.details).toBeNull();
      expect(r.raw).not.toContain(SECRET);
      expect(r.raw).not.toContain(USERS.tara);
      expect(r.raw).not.toContain(TEAMS.network);
      expect(r.raw).not.toContain(CATEGORIES.network);
      expect(r.raw).not.toMatch(/commentId|recommendationId|isInternal/);
    });

    it('is the same list as the timeline in the ticket detail', async () => {
      for (const who of [USERS.erin, USERS.tara]) {
        const detail = await call(who, 'GET', `/api/tickets/${ticketId}`);
        expect(detail.body.data.timeline).toEqual(await timeline(who, ticketId));
      }
    });

    it('orders by occurred_at then event_id, deterministically', async () => {
      const at = '2031-01-01T00:00:00Z';
      const ids = [
        'ffffffff-0000-4000-8000-000000000003',
        'ffffffff-0000-4000-8000-000000000001',
        'ffffffff-0000-4000-8000-000000000002',
      ];
      for (const id of ids) {
        await prisma.$executeRaw`
          INSERT INTO ticket_events (event_id, ticket_id, actor_id, event_type, details, occurred_at)
          VALUES (${id}::uuid, ${ticketId}::uuid, ${USERS.tara}::uuid, 'PRIORITY_UPDATED',
                  '{"from":"HIGH","to":"LOW"}'::jsonb, ${at}::timestamptz)`;
      }
      const t = await timeline(USERS.tara, ticketId);
      expect(t.slice(-3).map((e) => e.id)).toEqual([...ids].sort());
      expect(await timeline(USERS.tara, ticketId)).toEqual(t);
    });

    it('keeps other people out and requires authentication', async () => {
      const path = `/api/tickets/${ticketId}/events`;
      expect((await call(null, 'GET', path)).status).toBe(401);
      expect((await call(USERS.omar, 'GET', path)).status).toBe(404);
      expect((await call(USERS.hana, 'GET', path)).status).toBe(404);
      expect(
        (await call(USERS.erin, 'GET', '/api/tickets/00000000-0000-4000-8000-0000000000ff/events'))
          .status,
      ).toBe(404);
      expect((await call(USERS.erin, 'GET', '/api/tickets/nope/events')).status).toBe(404);
    });

    it('shows a technician who raised the ticket, outside their scope, the requester view', async () => {
      const own = (
        await submitTicket(prisma, { requesterId: USERS.hana, title: 'Mine', description: 'd' })
      ).ticket;
      await prisma.ticket.update({
        where: { id: own.id },
        data: { assignedTeamId: TEAMS.network },
      });
      await appendEvent(prisma, {
        ticketId: own.id,
        actorId: USERS.tara,
        type: 'AI_REVIEWED',
        details: { recommendationId: USERS.tara, decision: 'ACCEPTED' },
      });
      const t = await timeline(USERS.hana, own.id);
      expect(t.map((e) => e.type)).toEqual(['CREATED']);
      expect(t[0]!.actor).toBeNull();
    });
  });

  describe('tamper attempts', () => {
    it('offers no way to add, edit or delete events through the API', async () => {
      const t = await fresh();
      const before = await prisma.ticketEvent.count();
      const [event] = await rows(t.id);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        for (const url of [
          `/api/tickets/${t.id}/events`,
          `/api/tickets/${t.id}/events/${event!.id}`,
        ]) {
          const r = await call(USERS.admin, method, url, {
            type: 'CREATED',
            details: { from: 'OPEN' },
          });
          expect(r.status, `${method} ${url}`).toBe(404);
        }
      }
      expect(await prisma.ticketEvent.count()).toBe(before);
    });

    it('rejects UPDATE and DELETE in the database too', async () => {
      const t = await fresh();
      const [event] = await rows(t.id);
      await expect(
        prisma.ticketEvent.update({ where: { id: event!.id }, data: { eventType: 'REOPENED' } }),
      ).rejects.toThrow();
      await expect(prisma.ticketEvent.delete({ where: { id: event!.id } })).rejects.toThrow();
      expect(await types(t.id)).toEqual(['CREATED']);
    });

    it('cannot change history by editing the ticket through the API', async () => {
      const t = await fresh();
      const r = await call(USERS.erin, 'PATCH', `/api/tickets/${t.id}`, { status: 'CLOSED' });
      expect(r.status).toBe(404);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
      expect(await types(t.id)).toEqual(['CREATED']);
    });
  });
});
