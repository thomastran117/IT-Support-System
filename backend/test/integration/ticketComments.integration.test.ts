import type { FastifyInstance } from 'fastify';
import type { TicketCommentDto } from '@smartdesk/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);
const SECRET = 'INTERNAL-ONLY-secret-note';

interface Res {
  status: number;
  // Responses are asserted field by field; the shape differs per endpoint.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: { data: any; details: unknown };
}

describe.skipIf(!testDatabaseUrl)('ticket comments (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;
  let ticketId: string;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (
    as: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<Res> => {
    const res = await app.inject({
      method,
      url,
      headers: as ? await bearer(as) : {},
      payload: payload as object,
    });
    return { status: res.statusCode, body: res.json() };
  };
  const post = (as: string | null, body: unknown, id = ticketId) =>
    call(as, 'POST', `/api/tickets/${id}/comments`, body);
  const list = (as: string | null, id = ticketId) => call(as, 'GET', `/api/tickets/${id}/comments`);
  const makeTicket = (requesterId = USERS.erin, over: Record<string, unknown> = {}) =>
    prisma.ticket.create({
      data: {
        requesterId,
        title: 'Comment target',
        description: 'd',
        assignedTeamId: TEAMS.network,
        ...over,
      },
    });
  const counts = async () => ({
    comments: await prisma.ticketComment.count(),
    events: await prisma.ticketEvent.count(),
  });
  const firstResponse = async (id: string) =>
    (await prisma.ticket.findUniqueOrThrow({ where: { id } })).firstResponseAt;

  beforeAll(async () => {
    app = await buildApp({ env, prisma, checkDb: async () => true, logger: false });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    ticketId = (await makeTicket()).id;
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  describe('authoring and visibility', () => {
    it('lets the requester post a public comment, with server-assigned author and time', async () => {
      const before = await counts();
      const r = await post(USERS.erin, { body: '  Still broken  ' });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({
        body: 'Still broken',
        isInternal: false,
        author: { id: USERS.erin },
      });
      expect(new Date(r.body.data.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
      expect(await counts()).toEqual({ comments: before.comments + 1, events: before.events + 1 });
    });

    it('forbids an employee from writing an internal note and writes nothing', async () => {
      const before = await counts();
      const r = await post(USERS.erin, { body: 'x', isInternal: true });
      expect(r.status).toBe(403);
      expect(await counts()).toEqual(before);
    });

    it("hides other people's tickets from employees, by id and by guess", async () => {
      const before = await counts();
      expect((await post(USERS.omar, { body: 'x' })).status).toBe(404);
      expect((await list(USERS.omar)).status).toBe(404);
      expect(
        (await post(USERS.erin, { body: 'x' }, '00000000-0000-4000-8000-0000000000ff')).status,
      ).toBe(404);
      expect((await post(USERS.erin, { body: 'x' }, 'nope')).status).toBe(404);
      expect(await counts()).toEqual(before);
    });

    it('requires authentication', async () => {
      expect((await post(null, { body: 'x' })).status).toBe(401);
      expect((await list(null)).status).toBe(401);
    });

    it('never shows internal notes to the requester but shows them to staff in scope', async () => {
      await post(USERS.tara, { body: 'Public answer' });
      const note = await post(USERS.tara, { body: SECRET, isInternal: true });
      expect(note.status).toBe(201);
      expect(note.body.data.isInternal).toBe(true);

      const asEmployee = await list(USERS.erin);
      expect(asEmployee.body.data.map((c: TicketCommentDto) => c.body)).toEqual(['Public answer']);
      expect(JSON.stringify(asEmployee.body)).not.toContain(SECRET);

      for (const staff of [USERS.tara, USERS.tom, USERS.admin]) {
        const r = await list(staff);
        expect(r.body.data.map((c: TicketCommentDto) => c.body)).toEqual(['Public answer', SECRET]);
      }
      // The ticket detail applies the same rule.
      const detail = await call(USERS.erin, 'GET', `/api/tickets/${ticketId}`);
      expect(JSON.stringify(detail.body)).not.toContain(SECRET);
    });

    it('keeps technicians of other teams out entirely', async () => {
      expect((await post(USERS.hana, { body: 'x' })).status).toBe(404);
      expect((await list(USERS.hana)).status).toBe(404);
    });

    it('lets admins write internal notes', async () => {
      expect((await post(USERS.admin, { body: 'admin note', isInternal: true })).status).toBe(201);
    });

    it('lets a technician reply publicly on their own ticket outside their scope, but not internally', async () => {
      const own = await makeTicket(USERS.hana, { assignedTeamId: TEAMS.network });
      expect((await post(USERS.hana, { body: 'mine' }, own.id)).status).toBe(201);
      expect((await post(USERS.hana, { body: 'n', isInternal: true }, own.id)).status).toBe(403);
    });
  });

  describe('validation', () => {
    it.each([
      ['missing body', {}],
      ['empty body', { body: '' }],
      ['whitespace body', { body: ' \n\t ' }],
      ['oversized body', { body: 'x'.repeat(5001) }],
      ['non-string body', { body: 42 }],
      ['non-boolean isInternal', { body: 'x', isInternal: 'true' }],
      ['client-supplied author', { body: 'x', authorId: USERS.omar }],
      ['client-supplied timestamp', { body: 'x', createdAt: '2000-01-01T00:00:00Z' }],
    ])('rejects %s with 400 and writes nothing', async (_n, payload) => {
      const before = await counts();
      expect((await post(USERS.erin, payload)).status).toBe(400);
      expect(await counts()).toEqual(before);
    });

    it('accepts a body of exactly the maximum length', async () => {
      expect((await post(USERS.erin, { body: 'x'.repeat(5000) })).status).toBe(201);
    });
  });

  describe('ordering and immutability', () => {
    it('orders by createdAt then id when timestamps are equal', async () => {
      const at = new Date('2031-01-01T00:00:00.000Z');
      const ids = [
        'ffffffff-0000-4000-8000-000000000003',
        'ffffffff-0000-4000-8000-000000000001',
        'ffffffff-0000-4000-8000-000000000002',
      ];
      for (const id of ids) {
        await prisma.ticketComment.create({
          data: { id, ticketId, authorId: USERS.erin, body: `c-${id.slice(-1)}`, createdAt: at },
        });
      }
      const r = await list(USERS.erin);
      expect(r.body.data.map((c: TicketCommentDto) => c.id)).toEqual([...ids].sort());
      // Repeating the request gives the same order.
      expect((await list(USERS.erin)).body.data).toEqual(r.body.data);
    });

    it('lists comments oldest first', async () => {
      await post(USERS.erin, { body: 'one' });
      await post(USERS.tara, { body: 'two' });
      await post(USERS.erin, { body: 'three' });
      const bodies = (await list(USERS.erin)).body.data.map((c: TicketCommentDto) => c.body);
      expect(bodies).toEqual(['one', 'two', 'three']);
    });

    it('cannot be edited or deleted through the API or the database', async () => {
      const c = (await post(USERS.erin, { body: 'original' })).body.data;
      for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
        const r = await call(USERS.admin, method, `/api/tickets/${ticketId}/comments/${c.id}`, {
          body: 'tampered',
        });
        expect(r.status).toBe(404);
      }
      await expect(
        prisma.ticketComment.update({ where: { id: c.id }, data: { body: 'tampered' } }),
      ).rejects.toThrow();
      await expect(prisma.ticketComment.delete({ where: { id: c.id } })).rejects.toThrow();
      expect((await prisma.ticketComment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe(
        'original',
      );
    });
  });

  describe('audit event', () => {
    it('writes COMMENT_ADDED with ids and flags only, never the text', async () => {
      const r = await post(USERS.tara, { body: SECRET, isInternal: true });
      const events = await prisma.ticketEvent.findMany({
        where: { ticketId, eventType: 'COMMENT_ADDED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorId: USERS.tara });
      expect(events[0]!.details).toEqual({ commentId: r.body.data.id, isInternal: true });
      expect(JSON.stringify(events[0]!.details)).not.toContain(SECRET);
    });

    it('commits the comment and its event together, or neither', async () => {
      await prisma.$executeRawUnsafe(
        "CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced failure'; END $fn$",
      );
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER trg_fail_event BEFORE INSERT ON ticket_events FOR EACH ROW EXECUTE FUNCTION fail_event()',
      );
      try {
        const before = await counts();
        const r = await post(USERS.tara, { body: 'will roll back' });
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(await counts()).toEqual(before);
        expect(await firstResponse(ticketId)).toBeNull();
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER trg_fail_event ON ticket_events');
        await prisma.$executeRawUnsafe('DROP FUNCTION fail_event()');
      }
    });

    it('does not change the ticket version', async () => {
      const before = (await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).version;
      await post(USERS.erin, { body: 'a' });
      await post(USERS.tara, { body: 'b' });
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).version).toBe(
        before,
      );
    });
  });

  describe('first public response', () => {
    const exactTime = async (commentId: string) =>
      prisma.$queryRaw<{ same: boolean }[]>`
        SELECT t.first_response_at = c.created_at AS same
        FROM tickets t JOIN ticket_comments c ON c.ticket_id = t.ticket_id
        WHERE c.comment_id = ${commentId}::uuid`;

    it('is empty until a technician or admin replies publicly', async () => {
      await post(USERS.erin, { body: 'my own follow-up' });
      await post(USERS.tara, { body: 'private triage note', isInternal: true });
      expect(await firstResponse(ticketId)).toBeNull();
    });

    it('is the first public technician comment, stored exactly and never moved by later ones', async () => {
      const first = (await post(USERS.tara, { body: 'On it' })).body.data;
      const stored = await firstResponse(ticketId);
      expect(stored).not.toBeNull();
      expect((await exactTime(first.id))[0]!.same).toBe(true);

      await post(USERS.tom, { body: 'Update' });
      await post(USERS.admin, { body: 'FYI' });
      expect((await firstResponse(ticketId))!.getTime()).toBe(stored!.getTime());
    });

    it('counts an administrator public reply', async () => {
      const c = (await post(USERS.admin, { body: 'Looking' })).body.data;
      expect((await exactTime(c.id))[0]!.same).toBe(true);
    });

    it('ignores a technician replying on their own ticket', async () => {
      const own = await makeTicket(USERS.tara, { assignedTeamId: TEAMS.network });
      await post(USERS.tara, { body: 'note to self' }, own.id);
      expect(await firstResponse(own.id)).toBeNull();
    });

    it('stays stable when the author later changes role', async () => {
      await post(USERS.tara, { body: 'On it' });
      const stored = await firstResponse(ticketId);
      await prisma.user.update({ where: { id: USERS.tara }, data: { role: 'EMPLOYEE' } });
      expect((await firstResponse(ticketId))!.getTime()).toBe(stored!.getTime());
    });

    it('is exposed on the ticket list and detail', async () => {
      await post(USERS.tara, { body: 'On it' });
      const stored = (await firstResponse(ticketId))!.toISOString();
      const detail = await call(USERS.erin, 'GET', `/api/tickets/${ticketId}`);
      expect(detail.body.data.firstResponseAt).toBe(stored);
      const page = await call(USERS.erin, 'GET', '/api/tickets?limit=100');
      expect(
        page.body.data.items.find((t: { id: string }) => t.id === ticketId).firstResponseAt,
      ).toBe(stored);
    });

    it('marks the event that became the first response', async () => {
      await post(USERS.tara, { body: 'one' });
      await post(USERS.tara, { body: 'two' });
      const events = await prisma.ticketEvent.findMany({
        where: { ticketId, eventType: 'COMMENT_ADDED' },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
      expect(events.map((e) => (e.details as { firstResponse?: boolean }).firstResponse)).toEqual([
        true,
        undefined,
      ]);
    });

    it('settles on the earliest reply when many are posted at once', async () => {
      const results = await Promise.all(
        [USERS.tara, USERS.tom, USERS.admin, USERS.tara, USERS.tom, USERS.admin].map((u, i) =>
          post(u, { body: `reply ${i}` }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const earliest = await prisma.$queryRaw<{ first: Date }[]>`
        SELECT MIN(created_at) AS first FROM ticket_comments WHERE ticket_id = ${ticketId}::uuid`;
      expect((await firstResponse(ticketId))!.getTime()).toBe(earliest[0]!.first.getTime());
      expect(await prisma.ticketComment.count({ where: { ticketId } })).toBe(6);
    });

    it('matches the documented rule for every seeded ticket', async () => {
      const mismatches = await prisma.$queryRaw<{ ticket_id: string }[]>`
        SELECT t.ticket_id
        FROM tickets t
        LEFT JOIN LATERAL (
          SELECT MIN(c.created_at) AS first_at
          FROM ticket_comments c JOIN users u ON u.user_id = c.author_id
          WHERE c.ticket_id = t.ticket_id AND NOT c.is_internal
            AND u.role IN ('TECHNICIAN', 'ADMIN') AND c.author_id <> t.requester_id
            AND c.created_at >= t.created_at
        ) d ON TRUE
        WHERE t.first_response_at IS DISTINCT FROM d.first_at`;
      expect(mismatches).toEqual([]);
      expect(
        await prisma.ticket.count({ where: { firstResponseAt: { not: null } } }),
      ).toBeGreaterThan(0);
    });

    it('is queryable for reporting', async () => {
      await post(USERS.tara, { body: 'On it' });
      const rows = await prisma.$queryRaw<{ n: bigint; avg_minutes: number }[]>`
        SELECT COUNT(*) AS n,
               AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60)::float AS avg_minutes
        FROM tickets WHERE first_response_at IS NOT NULL`;
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
      expect(rows[0]!.avg_minutes).toBeGreaterThanOrEqual(0);
    });
  });
});
