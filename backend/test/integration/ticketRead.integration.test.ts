import type { FastifyInstance } from 'fastify';
import type { TicketDetailDto, TicketPage } from '@smartdesk/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const SECRET = 'INTERNAL-ONLY-secret-note';

describe.skipIf(!testDatabaseUrl)('GET /api/tickets and /api/tickets/:id (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const get = async (as: string | null, url: string) =>
    app.inject({ method: 'GET', url, headers: as ? await bearer(as) : {} });
  const list = async (as: string, query = ''): Promise<TicketPage> => {
    const res = await get(as, `/api/tickets${query}`);
    expect(res.statusCode).toBe(200);
    return res.json().data;
  };
  const visibleTo = async (userId: string) => {
    const principalTeams = (await prisma.teamMember.findMany({ where: { userId } })).map(
      (m) => m.teamId,
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return (await prisma.ticket.findMany()).filter((t) => {
      if (user.role === 'ADMIN') return true;
      if (t.requesterId === userId) return true;
      return (
        user.role === 'TECHNICIAN' &&
        principalTeams.length > 0 &&
        (t.assignedTeamId === null || principalTeams.includes(t.assignedTeamId))
      );
    });
  };

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

  describe('visibility', () => {
    it('requires authentication', async () => {
      expect((await get(null, '/api/tickets')).statusCode).toBe(401);
      expect((await get(null, `/api/tickets/${TICKETS.printer}`)).statusCode).toBe(401);
    });

    it('lists only the employee own tickets, with a matching total', async () => {
      for (const who of [USERS.erin, USERS.omar]) {
        const page = await list(who, '?limit=100');
        const expected = (await prisma.ticket.findMany({ where: { requesterId: who } })).map(
          (t) => t.id,
        );
        expect(expected.length).toBeGreaterThan(0);
        expect(page.items.map((i) => i.id).sort()).toEqual(expected.sort());
        expect(page.total).toBe(expected.length);
      }
    });

    it("never lets employee A read employee B's ticket, by id or by guessing", async () => {
      const omarsTicket = await prisma.ticket.findFirstOrThrow({
        where: { requesterId: USERS.omar },
      });
      const res = await get(USERS.erin, `/api/tickets/${omarsTicket.id}`);
      const missing = await get(USERS.erin, `/api/tickets/${MISSING}`);
      expect(res.statusCode).toBe(404);
      // Indistinguishable from a ticket that does not exist.
      expect(res.json()).toEqual(missing.json());
      expect((await get(USERS.erin, '/api/tickets/not-a-uuid')).statusCode).toBe(404);
    });

    it('scopes technicians to their teams and the unrouted backlog, admins to everything', async () => {
      for (const who of [USERS.tara, USERS.hana, USERS.admin]) {
        const expected = (await visibleTo(who)).map((t) => t.id).sort();
        const page = await list(who, '?limit=100');
        expect(page.items.map((i) => i.id).sort()).toEqual(expected);
        expect(page.total).toBe(expected.length);
      }
      const hardwareOnly = await prisma.ticket.findFirstOrThrow({
        where: { assignedTeamId: TEAMS.hardware, requesterId: { not: USERS.tara } },
      });
      expect((await get(USERS.tara, `/api/tickets/${hardwareOnly.id}`)).statusCode).toBe(
        (await visibleTo(USERS.tara)).some((t) => t.id === hardwareOnly.id) ? 200 : 404,
      );
      expect((await get(USERS.hana, `/api/tickets/${hardwareOnly.id}`)).statusCode).toBe(200);
    });
  });

  describe('pagination and filters', () => {
    const makeTickets = async (n: number, sameTime = false) => {
      const base = new Date('2030-01-01T00:00:00.000Z');
      for (let i = 0; i < n; i++) {
        await prisma.ticket.create({
          data: {
            requesterId: USERS.erin,
            title: `Bulk ${i}`,
            description: 'bulk',
            createdAt: sameTime ? base : new Date(base.getTime() + i * 1000),
          },
        });
      }
    };

    it('walks every page once, newest first, with next-offset metadata', async () => {
      await makeTickets(25);
      const total = await prisma.ticket.count({ where: { requesterId: USERS.erin } });
      const seen: string[] = [];
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const page: TicketPage = await list(USERS.erin, `?limit=10&offset=${offset}`);
        expect(page.total).toBe(total);
        expect(page.items.length).toBeLessThanOrEqual(10);
        seen.push(...page.items.map((i) => i.id));
        offset = page.nextOffset;
        pages++;
      }
      expect(pages).toBe(Math.ceil(total / 10));
      expect(new Set(seen).size).toBe(total);
      const rows = await prisma.ticket.findMany({
        where: { id: { in: seen } },
        select: { id: true, createdAt: true },
      });
      const at = new Map(rows.map((r) => [r.id, r.createdAt.getTime()]));
      const times = seen.map((id) => at.get(id)!);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('keeps a total order when many tickets share one timestamp', async () => {
      await makeTickets(12, true);
      const a = await list(USERS.erin, '?limit=5&offset=0');
      const b = await list(USERS.erin, '?limit=5&offset=5');
      const c = await list(USERS.erin, '?limit=5&offset=10');
      const ids = [...a.items, ...b.items, ...c.items].map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      const again = await list(USERS.erin, '?limit=5&offset=5');
      expect(again.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    });

    it('applies the filters to rows and total', async () => {
      const open = await list(USERS.erin, '?status=OPEN&limit=100');
      expect(open.items.length).toBeGreaterThan(0);
      expect(open.items.every((i) => i.status === 'OPEN')).toBe(true);
      expect(open.total).toBe(
        await prisma.ticket.count({ where: { requesterId: USERS.erin, status: 'OPEN' } }),
      );
      const high = await list(USERS.admin, '?priority=HIGH&limit=100');
      expect(high.items.every((i) => i.priority === 'HIGH')).toBe(true);
      const both = await list(USERS.admin, '?status=IN_PROGRESS&priority=HIGH&limit=100');
      expect(both.items.every((i) => i.status === 'IN_PROGRESS' && i.priority === 'HIGH')).toBe(
        true,
      );
    });

    it('returns an empty last page past the end', async () => {
      const page = await list(USERS.erin, '?offset=1000');
      expect(page.items).toEqual([]);
      expect(page.nextOffset).toBeNull();
      expect(page.total).toBeGreaterThan(0);
    });

    it('defaults the page size and rejects out-of-range or unknown parameters', async () => {
      await makeTickets(30);
      expect((await list(USERS.erin)).items).toHaveLength(20);
      for (const q of ['?limit=101', '?limit=0', '?offset=-1', '?status=NOPE', '?requester=x']) {
        expect((await get(USERS.erin, `/api/tickets${q}`)).statusCode).toBe(400);
      }
    });

    it('resolves category, team and assignee in the list itself', async () => {
      const routed = await prisma.ticket.findFirstOrThrow({
        where: { assigneeId: { not: null }, requesterId: USERS.erin },
      });
      const page = await list(USERS.erin, '?limit=100');
      const item = page.items.find((i) => i.id === routed.id)!;
      expect(item.team?.name).toBeTruthy();
      expect(item.category?.name).toBeTruthy();
      expect(item.assignee?.name).toBeTruthy();
      expect(Object.keys(item)).not.toContain('description');
    });
  });

  describe('detail and internal data', () => {
    let ticketId: string;
    beforeEach(async () => {
      const t = await prisma.ticket.findFirstOrThrow({
        where: { requesterId: USERS.erin, assignedTeamId: TEAMS.network },
      });
      ticketId = t.id;
      await prisma.ticketComment.create({
        data: { ticketId, authorId: USERS.tara, body: 'Public reply', isInternal: false },
      });
      await prisma.ticketComment.create({
        data: { ticketId, authorId: USERS.tara, body: SECRET, isInternal: true },
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO ticket_events (ticket_id, actor_id, event_type, details)
         VALUES ('${ticketId}', '${USERS.tara}', 'AI_REVIEWED', '{"note":"${SECRET}"}')`,
      );
    });

    it('hides internal notes, private events and actor ids from the requester', async () => {
      const res = await get(USERS.erin, `/api/tickets/${ticketId}`);
      expect(res.statusCode).toBe(200);
      const d: TicketDetailDto = res.json().data;
      expect(d.comments.map((c) => c.body)).toContain('Public reply');
      expect(d.comments.every((c) => !c.isInternal)).toBe(true);
      expect(res.body).not.toContain(SECRET);
      expect(d.timeline.some((e) => e.type === 'AI_REVIEWED')).toBe(false);
      expect(d.timeline.every((e) => e.actor === null)).toBe(true);
      expect(d.timeline.some((e) => e.type === 'CREATED')).toBe(true);
      // Tara's public reply legitimately names her as comment author; the timeline must not.
      expect(JSON.stringify(d.timeline)).not.toContain(USERS.tara);
      expect(res.body).not.toMatch(/commentId|recommendation/i);
      // Comments and timeline are ordered oldest first.
      const stamps = d.comments.map((c) => c.createdAt);
      expect(stamps).toEqual([...stamps].sort());
    });

    it('shows staff in scope the internal notes and the raw timeline', async () => {
      for (const who of [USERS.tara, USERS.admin]) {
        const res = await get(who, `/api/tickets/${ticketId}`);
        expect(res.statusCode).toBe(200);
        const d: TicketDetailDto = res.json().data;
        expect(d.comments.some((c) => c.isInternal && c.body === SECRET)).toBe(true);
        expect(d.timeline.some((e) => e.type === 'AI_REVIEWED' && e.actor?.id === USERS.tara)).toBe(
          true,
        );
      }
    });

    it('treats a technician who raised the ticket like an employee outside their scope', async () => {
      const own = await prisma.ticket.create({
        data: { requesterId: USERS.hana, title: 'Mine', description: 'd', assignedTeamId: null },
      });
      await prisma.ticket.update({
        where: { id: own.id },
        data: { assignedTeamId: TEAMS.network },
      });
      await prisma.ticketComment.create({
        data: { ticketId: own.id, authorId: USERS.tara, body: SECRET, isInternal: true },
      });
      const res = await get(USERS.hana, `/api/tickets/${own.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SECRET);
    });

    it('returns the approved fields and a version for concurrency', async () => {
      const d: TicketDetailDto = (await get(USERS.erin, `/api/tickets/${ticketId}`)).json().data;
      expect(d.trackingId).toBe(ticketId);
      expect(d.team?.id).toBe(TEAMS.network);
      expect(d.requester.id).toBe(USERS.erin);
      expect(d.version).toBeGreaterThanOrEqual(1);
      expect(d.description).toBeTruthy();
    });
  });
});
