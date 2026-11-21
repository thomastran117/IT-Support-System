import type { FastifyInstance } from 'fastify';
import type { TicketStatus } from '@smartdesk/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TICKET_STATUSES } from '../../src/domain/ticketStateMachine.js';
import { CATEGORIES, TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { transitionTicket } from '../../src/db/services/ticketService.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

interface ApiBody {
  data: {
    status: string;
    version: number;
    resolutionSummary: string | null;
    resolvedAt: string | null;
  };
  details: Record<string, unknown> & { code?: string };
}

const EDGES = new Set([
  'OPEN>TRIAGED',
  'TRIAGED>IN_PROGRESS',
  'IN_PROGRESS>RESOLVED',
  'RESOLVED>CLOSED',
  'RESOLVED>OPEN',
  'CLOSED>OPEN',
]);

describe.skipIf(!testDatabaseUrl)('POST /api/tickets/:id/transitions (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const move = async (
    as: string | null,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: ApiBody }> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${id}/transitions`,
      headers: as ? await bearer(as) : {},
      payload: body,
    });
    return { status: res.statusCode, body: res.json() as ApiBody };
  };
  const row = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { id } });
  const eventTypes = async (id: string) =>
    (
      await prisma.ticketEvent.findMany({
        where: { ticketId: id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      })
    ).map((e) => e.eventType);
  const snapshot = async (id: string) => ({
    ticket: await row(id),
    events: await prisma.ticketEvent.count({ where: { ticketId: id } }),
  });

  /** A ticket of Erin's in the network team, in the given status, satisfying every CHECK. */
  const make = async (status: TicketStatus, over: Record<string, unknown> = {}) => {
    const done = status === 'RESOLVED' || status === 'CLOSED';
    return prisma.ticket.create({
      data: {
        requesterId: USERS.erin,
        title: `Ticket ${status}`,
        description: 'd',
        status,
        categoryId: CATEGORIES.network,
        priority: 'HIGH',
        assignedTeamId: TEAMS.network,
        ...(done ? { resolvedAt: new Date(Date.now() + 1000), resolutionSummary: 'Fixed it' } : {}),
        ...over,
      },
    });
  };

  beforeAll(async () => {
    app = await buildApp({ env, prisma, checkDb: async () => true, logger: false });
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

  it('walks the whole lifecycle through the API, one audited step at a time', async () => {
    const t = await make('OPEN');
    let version = t.version;
    const step = async (as: string, to: string, extra: Record<string, unknown> = {}) => {
      const r = await move(as, t.id, { to, expectedVersion: version, ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.status).toBe(to);
      expect(r.body.data.version).toBe(version + 1);
      version = r.body.data.version;
      return r.body.data;
    };
    await step(USERS.tara, 'TRIAGED');
    await step(USERS.tara, 'IN_PROGRESS');
    const resolved = await step(USERS.tara, 'RESOLVED', { resolutionSummary: '  Reinstalled  ' });
    expect(resolved.resolutionSummary).toBe('Reinstalled');
    expect(resolved.resolvedAt).toBeTruthy();
    const closed = await step(USERS.tara, 'CLOSED');
    expect(closed.resolvedAt).toBe(resolved.resolvedAt);
    const reopened = await step(USERS.erin, 'OPEN');
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolutionSummary).toBeNull();

    expect(await eventTypes(t.id)).toEqual([
      'STATUS_CHANGED',
      'STATUS_CHANGED',
      'RESOLVED',
      'STATUS_CHANGED',
      'REOPENED',
    ]);
  });

  it('reopens from RESOLVED and CLOSED, clearing current fields but keeping history', async () => {
    for (const from of ['RESOLVED', 'CLOSED'] as const) {
      const t = await make(from);
      await prisma.ticketEvent.create({
        data: { ticketId: t.id, actorId: USERS.tara, eventType: 'RESOLVED', details: {} },
      });
      const r = await move(USERS.erin, t.id, { to: 'OPEN', expectedVersion: t.version });
      expect(r.status).toBe(200);
      const after = await row(t.id);
      expect(after).toMatchObject({ status: 'OPEN', resolvedAt: null, resolutionSummary: null });
      const types = await eventTypes(t.id);
      expect(types).toContain('RESOLVED');
      expect(types.at(-1)).toBe('REOPENED');
    }
  });

  it('stamps a fresh resolution after a reopen', async () => {
    const t = await make('IN_PROGRESS');
    const first = await move(USERS.tara, t.id, {
      to: 'RESOLVED',
      expectedVersion: t.version,
      resolutionSummary: 'First fix',
    });
    const reopened = await move(USERS.erin, t.id, {
      to: 'OPEN',
      expectedVersion: first.body.data.version,
    });
    // OPEN -> TRIAGED -> IN_PROGRESS -> RESOLVED again
    let v = reopened.body.data.version;
    for (const to of ['TRIAGED', 'IN_PROGRESS']) {
      v = (await move(USERS.tara, t.id, { to, expectedVersion: v })).body.data.version;
    }
    const second = await move(USERS.tara, t.id, {
      to: 'RESOLVED',
      expectedVersion: v,
      resolutionSummary: 'Second fix',
    });
    expect(second.body.data.resolutionSummary).toBe('Second fix');
    expect(new Date(second.body.data.resolvedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.body.data.resolvedAt).getTime(),
    );
    expect((await eventTypes(t.id)).filter((e) => e === 'RESOLVED')).toHaveLength(2);
  });

  describe('invalid edges', () => {
    const forbidden = TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.filter((to) => !EDGES.has(`${from}>${to}`)).map((to) => [from, to] as const),
    );

    it.each(forbidden)(
      '%s -> %s is a 409 INVALID_TRANSITION that changes nothing',
      async (from, to) => {
        const t = await make(from);
        const before = await snapshot(t.id);
        const r = await move(USERS.admin, t.id, {
          to,
          expectedVersion: t.version,
          resolutionSummary: 'x',
        });
        expect(r.status).toBe(409);
        expect(r.body.details).toMatchObject({ code: 'INVALID_TRANSITION', from, to });
        expect(await snapshot(t.id)).toEqual(before);
      },
    );
  });

  describe('prerequisites', () => {
    it('refuses to triage a ticket with nothing approved and says what is missing', async () => {
      const t = await make('OPEN', { categoryId: null, priority: 'UNSET', assignedTeamId: null });
      const before = await snapshot(t.id);
      const r = await move(USERS.tara, t.id, { to: 'TRIAGED', expectedVersion: t.version });
      expect(r.status).toBe(409);
      expect(r.body.details).toMatchObject({
        code: 'PREREQUISITE_FAILED',
        missing: ['CATEGORY', 'PRIORITY', 'TEAM'],
      });
      expect(await snapshot(t.id)).toEqual(before);
    });

    it('refuses an unset priority, an inactive team and an ineligible assignee', async () => {
      const noPriority = await make('OPEN', { priority: 'UNSET' });
      let r = await move(USERS.tara, noPriority.id, { to: 'TRIAGED', expectedVersion: 1 });
      expect(r.body.details).toMatchObject({ code: 'PREREQUISITE_FAILED', missing: ['PRIORITY'] });

      const triaged = await make('TRIAGED');
      await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: false } });
      // Tara's team is now inactive, so she is out of scope; the admin can still act.
      r = await move(USERS.admin, triaged.id, { to: 'IN_PROGRESS', expectedVersion: 1 });
      expect(r.status).toBe(409);
      expect(r.body.details).toMatchObject({
        code: 'PREREQUISITE_FAILED',
        missing: ['ACTIVE_TEAM'],
      });
      await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: true } });

      const assigned = await make('TRIAGED', { assigneeId: USERS.tara });
      await prisma.user.update({ where: { id: USERS.tara }, data: { isActive: false } });
      r = await move(USERS.admin, assigned.id, { to: 'IN_PROGRESS', expectedVersion: 1 });
      expect(r.body.details).toMatchObject({ code: 'PREREQUISITE_FAILED', missing: ['ASSIGNEE'] });
      expect((await row(assigned.id)).status).toBe('TRIAGED');
    });

    it('lets a fully routed ticket with an eligible assignee start work', async () => {
      const t = await make('TRIAGED', { assigneeId: USERS.tara });
      const r = await move(USERS.tara, t.id, { to: 'IN_PROGRESS', expectedVersion: t.version });
      expect(r.status).toBe(200);
    });
  });

  describe('resolution summary and input validation', () => {
    it('requires a nonblank summary to resolve (422) and leaves the ticket unchanged', async () => {
      const t = await make('IN_PROGRESS');
      const before = await snapshot(t.id);
      for (const body of [{}, { resolutionSummary: '   ' }]) {
        const r = await move(USERS.tara, t.id, { to: 'RESOLVED', expectedVersion: 1, ...body });
        expect(r.status).toBe(422);
        expect(r.body.details).toMatchObject({ code: 'VALIDATION' });
      }
      expect(await snapshot(t.id)).toEqual(before);
    });

    it.each([
      ['missing expectedVersion', { to: 'TRIAGED' }],
      ['zero version', { to: 'TRIAGED', expectedVersion: 0 }],
      ['string version', { to: 'TRIAGED', expectedVersion: '1' }],
      ['unknown status', { to: 'DONE', expectedVersion: 1 }],
      ['missing target', { expectedVersion: 1 }],
      ['extra field', { to: 'TRIAGED', expectedVersion: 1, priority: 'LOW' }],
      [
        'oversized summary',
        { to: 'RESOLVED', expectedVersion: 1, resolutionSummary: 'x'.repeat(5001) },
      ],
    ])('rejects %s with 400', async (_n, body) => {
      const t = await make('OPEN');
      expect((await move(USERS.tara, t.id, body)).status).toBe(400);
      expect(await row(t.id)).toMatchObject({ status: 'OPEN', version: 1 });
    });
  });

  describe('authorization', () => {
    it('requires authentication', async () => {
      const t = await make('OPEN');
      expect((await move(null, t.id, { to: 'TRIAGED', expectedVersion: 1 })).status).toBe(401);
    });

    it('hides tickets the caller cannot read (404) and forbids readers who cannot work them (403)', async () => {
      const t = await make('OPEN');
      const body = { to: 'TRIAGED', expectedVersion: 1 };
      expect((await move(USERS.omar, t.id, body)).status).toBe(404); // another employee
      expect((await move(USERS.hana, t.id, body)).status).toBe(404); // other team's technician
      expect((await move(USERS.erin, t.id, body)).status).toBe(403); // the requester cannot triage
      expect((await row(t.id)).status).toBe('OPEN');
    });

    it('lets only the requester (or staff in scope) reopen', async () => {
      const t = await make('CLOSED');
      expect((await move(USERS.omar, t.id, { to: 'OPEN', expectedVersion: 1 })).status).toBe(404);
      expect((await move(USERS.tara, t.id, { to: 'OPEN', expectedVersion: 1 })).status).toBe(200);
    });

    it('treats a technician in no active team as out of scope even for the unrouted backlog', async () => {
      const t = await make('OPEN', { assignedTeamId: null, categoryId: null, priority: 'UNSET' });
      const loner = await prisma.user.create({
        data: { email: 'loner@smartdesk.test', displayName: 'Loner', role: 'TECHNICIAN' },
      });
      await expect(
        transitionTicket(prisma, { ticketId: t.id, actorId: loner.id, to: 'TRIAGED' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await row(t.id)).status).toBe('OPEN');
    });

    it('rejects inactive actors', async () => {
      const t = await make('OPEN');
      await prisma.user.update({ where: { id: USERS.tara }, data: { isActive: false } });
      await expect(
        transitionTicket(prisma, { ticketId: t.id, actorId: USERS.tara, to: 'TRIAGED' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('optimistic concurrency', () => {
    it('answers a stale version with 409 VERSION_CONFLICT and the current version', async () => {
      const t = await make('OPEN');
      await move(USERS.tara, t.id, { to: 'TRIAGED', expectedVersion: 1 });
      const before = await snapshot(t.id);
      const r = await move(USERS.tom, t.id, { to: 'TRIAGED', expectedVersion: 1 });
      expect(r.status).toBe(409);
      expect(r.body.details).toEqual({ code: 'VERSION_CONFLICT', currentVersion: 2 });
      expect(await snapshot(t.id)).toEqual(before);
    });

    it('reports a stale version before an invalid edge so the client reloads first', async () => {
      const t = await make('OPEN');
      await move(USERS.tara, t.id, { to: 'TRIAGED', expectedVersion: 1 });
      const r = await move(USERS.tara, t.id, {
        to: 'RESOLVED',
        expectedVersion: 1,
        resolutionSummary: 'x',
      });
      expect(r.body.details.code).toBe('VERSION_CONFLICT');
    });

    it('lets exactly one of many simultaneous transitions win', async () => {
      const t = await make('OPEN');
      const actors = [USERS.tara, USERS.tom, USERS.admin, USERS.tara, USERS.tom, USERS.admin];
      const results = await Promise.all(
        actors.map((a) => move(a, t.id, { to: 'TRIAGED', expectedVersion: 1 })),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const losers = results.filter((r) => r.status !== 200);
      expect(losers).toHaveLength(5);
      // A loser that arrives after the commit sees the stale version; one that raced it fails the
      // conditional write. Both report the same machine-readable conflict.
      expect(
        losers.every((r) => r.status === 409 && r.body.details.code === 'VERSION_CONFLICT'),
      ).toBe(true);
      expect(await row(t.id)).toMatchObject({ status: 'TRIAGED', version: 2 });
      expect(await eventTypes(t.id)).toEqual(['STATUS_CHANGED']);
    });

    it('never leaves an invalid intermediate state when different edges race', async () => {
      const t = await make('RESOLVED');
      const attempts = [
        { to: 'CLOSED' },
        { to: 'OPEN' },
        { to: 'CLOSED' },
        { to: 'OPEN' },
        { to: 'TRIAGED' },
        { to: 'IN_PROGRESS' },
      ];
      const results = await Promise.all(
        attempts.map((a, i) =>
          move([USERS.tara, USERS.erin][i % 2]!, t.id, { ...a, expectedVersion: t.version }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const final = await row(t.id);
      expect(final.version).toBe(t.version + 1);
      expect(['CLOSED', 'OPEN']).toContain(final.status);
      // The database CHECKs held: resolution fields match the final status.
      if (final.status === 'OPEN') {
        expect(final.resolvedAt).toBeNull();
        expect(final.resolutionSummary).toBeNull();
      } else {
        expect(final.resolvedAt).not.toBeNull();
        expect(final.resolutionSummary).toBeTruthy();
      }
      expect(await eventTypes(t.id)).toHaveLength(1);
    });

    it('lets a service caller that names no version win through retries', async () => {
      const t = await make('OPEN');
      // Five direct service calls with no expected version: each re-reads on a lost race, so
      // exactly one changes OPEN -> TRIAGED and the rest report the (now invalid) edge.
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          transitionTicket(prisma, { ticketId: t.id, actorId: USERS.tara, to: 'TRIAGED' }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
        expect(r.reason).toMatchObject({ code: 'INVALID_TRANSITION' });
      }
      expect(await eventTypes(t.id)).toEqual(['STATUS_CHANGED']);
    });
  });

  it('rolls the status change back when its audit event cannot be written', async () => {
    const t = await make('OPEN');
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced failure'; END $fn$",
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER trg_fail_event BEFORE INSERT ON ticket_events FOR EACH ROW EXECUTE FUNCTION fail_event()',
    );
    try {
      const before = await snapshot(t.id);
      const r = await move(USERS.tara, t.id, { to: 'TRIAGED', expectedVersion: 1 });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await snapshot(t.id)).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER trg_fail_event ON ticket_events');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_event()');
    }
  });
});
