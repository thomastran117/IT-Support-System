import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, TEAMS, TICKETS, USERS, uuid } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, insertRow, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

interface Item {
  id: string;
  priority: string;
  status: string;
  ageMinutes: number;
  version: number;
  category: { id: string } | null;
  assignee: { id: string } | null;
}
interface Page {
  items: Item[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

describe.skipIf(!testDatabaseUrl)('technician queues (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const get = async (as: string | null, url: string) =>
    app.inject({ method: 'GET', url, headers: as ? await bearer(as) : {} });
  const queue = (as: string | null, team: string, qs = '') =>
    get(as, `/api/technician/queue?teamId=${team}${qs}`);
  const unassigned = (as: string | null, qs = '') => get(as, `/api/technician/unassigned${qs}`);
  const ids = (res: { json: () => { data: Page } }) => res.json().data.items.map((i) => i.id);

  const mk = (n: number, priority: string, created: string, over: Record<string, unknown> = {}) =>
    insertRow(prisma, 'tickets', {
      ticket_id: uuid('ticket', 200 + n),
      requester_id: USERS.erin,
      title: `queue ${n}`,
      description: 'private details',
      priority,
      status: 'OPEN',
      category_id: CATEGORIES.hardware,
      created_at: new Date(created),
      updated_at: new Date(created),
      ...over,
    });

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

  describe('access', () => {
    it('is 401 for anonymous callers and 403 for employees', async () => {
      for (const call of [
        (as: string | null) => queue(as, TEAMS.network),
        (as: string | null) => unassigned(as),
      ]) {
        expect((await call(null)).statusCode).toBe(401);
        expect((await call(USERS.erin)).statusCode).toBe(403);
      }
    });

    it('lets a technician read only their own teams, with 403 for another team', async () => {
      expect((await queue(USERS.tara, TEAMS.network)).statusCode).toBe(200);
      expect((await queue(USERS.tara, TEAMS.hardware)).statusCode).toBe(403);
      expect((await queue(USERS.hana, TEAMS.network)).statusCode).toBe(403);
      // Tom is in both teams.
      expect((await queue(USERS.tom, TEAMS.network)).statusCode).toBe(200);
      expect((await queue(USERS.tom, TEAMS.hardware)).statusCode).toBe(200);
    });

    it('closes the queue of an inactive team to its technicians but not to admins', async () => {
      expect((await queue(USERS.ingrid, TEAMS.legacy)).statusCode).toBe(401); // inactive account
      await prisma.supportTeam.update({ where: { id: TEAMS.hardware }, data: { isActive: false } });
      expect((await queue(USERS.hana, TEAMS.hardware)).statusCode).toBe(403);
      expect((await queue(USERS.admin, TEAMS.hardware)).statusCode).toBe(200);
    });

    it('lets an admin read any team, and 404s an unknown one', async () => {
      expect((await queue(USERS.admin, TEAMS.hardware)).statusCode).toBe(200);
      expect((await queue(USERS.admin, TEAMS.legacy)).json().data.total).toBe(0);
      expect((await queue(USERS.admin, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(
        404,
      );
    });

    it('ignores any attempt to name another authority: unknown parameters are rejected', async () => {
      expect((await queue(USERS.tara, TEAMS.network, '&requesterId=x')).statusCode).toBe(400);
      expect((await queue(USERS.tara, TEAMS.network, '&role=ADMIN')).statusCode).toBe(400);
      expect((await get(USERS.tara, '/api/technician/queue')).statusCode).toBe(400);
      expect((await get(USERS.tara, '/api/technician/queue?teamId=nope')).statusCode).toBe(400);
    });

    it('denies the shared backlog to a technician who belongs to no active team', async () => {
      const loner = await prisma.user.create({
        data: { email: 'loner@smartdesk.test', displayName: 'Loner', role: 'TECHNICIAN' },
      });
      expect((await unassigned(loner.id)).statusCode).toBe(403);
      expect((await unassigned(USERS.tara)).statusCode).toBe(200);
      expect((await unassigned(USERS.admin)).statusCode).toBe(200);
    });

    it('exposes summary fields only', async () => {
      const item = (await queue(USERS.tara, TEAMS.network)).json().data.items[0];
      expect(Object.keys(item).sort()).toEqual(
        [
          'ageMinutes',
          'assignee',
          'category',
          'createdAt',
          'id',
          'priority',
          'status',
          'title',
          'version',
        ].sort(),
      );
      const raw = (await unassigned(USERS.tara)).body;
      expect(raw).not.toContain('private');
      expect(raw).not.toContain('requester');
      expect(raw).not.toContain('description');
    });
  });

  describe('team queue', () => {
    it('lists unresolved tickets: HIGH before MEDIUM, oldest first, resolved excluded', async () => {
      const res = await queue(USERS.tara, TEAMS.network);
      expect(ids(res)).toEqual([TICKETS.vpn, TICKETS.license, TICKETS.reopened]);
      expect(res.json().data).toMatchObject({ total: 3, limit: 20, offset: 0, nextOffset: null });
      expect(res.json().data.items[1]).toMatchObject({
        priority: 'MEDIUM',
        status: 'IN_PROGRESS',
        assignee: { id: USERS.tom },
        category: { id: CATEGORIES.software },
      });
    });

    it('orders CRITICAL, HIGH, MEDIUM, LOW, UNSET with creation time then id as tie-breakers', async () => {
      const t = TEAMS.hardware;
      await mk(1, 'UNSET', '2026-01-01T00:00:00Z', { assigned_team_id: t, category_id: null });
      await mk(2, 'LOW', '2026-01-01T00:00:00Z', { assigned_team_id: t });
      await mk(3, 'CRITICAL', '2026-02-01T00:00:00Z', { assigned_team_id: t });
      await mk(4, 'CRITICAL', '2026-02-01T00:00:00Z', { assigned_team_id: t });
      await mk(5, 'HIGH', '2026-02-02T00:00:00Z', { assigned_team_id: t });
      const res = await queue(USERS.hana, t);
      expect(ids(res)).toEqual([
        uuid('ticket', 203),
        uuid('ticket', 204),
        uuid('ticket', 205),
        TICKETS.boundary,
        uuid('ticket', 202),
        uuid('ticket', 201),
      ]);
      expect(res.json().data.items[5].category).toBeNull();
    });

    it('sorts purely by age when asked, and rejects unknown sort options', async () => {
      const res = await queue(USERS.tara, TEAMS.network, '&sort=age');
      expect(ids(res)).toEqual([TICKETS.vpn, TICKETS.license, TICKETS.reopened]);
      await mk(1, 'CRITICAL', '2026-03-10T00:00:00Z', { assigned_team_id: TEAMS.network });
      const byAge = await queue(USERS.tara, TEAMS.network, '&sort=age');
      expect(ids(byAge).at(-1)).toBe(uuid('ticket', 201));
      const byPriority = await queue(USERS.tara, TEAMS.network);
      expect(ids(byPriority)[0]).toBe(uuid('ticket', 201));
      expect((await queue(USERS.tara, TEAMS.network, '&sort=random')).statusCode).toBe(400);
    });

    it('filters by status, priority, category and creation date, and counts the filtered set', async () => {
      const t = TEAMS.network;
      let res = await queue(USERS.tara, t, '&status=IN_PROGRESS');
      expect(ids(res)).toEqual([TICKETS.license]);
      expect(res.json().data.total).toBe(1);

      res = await queue(USERS.tara, t, '&status=RESOLVED,CLOSED');
      expect(ids(res)).toEqual([TICKETS.password]);

      res = await queue(USERS.tara, t, '&priority=MEDIUM');
      expect(ids(res)).toEqual([TICKETS.license, TICKETS.reopened]);

      res = await queue(USERS.tara, t, `&categoryId=${CATEGORIES.network}`);
      expect(ids(res)).toEqual([TICKETS.vpn]);

      res = await queue(USERS.tara, t, '&createdFrom=2026-03-03T00:00:00Z');
      expect(ids(res)).toEqual([TICKETS.license, TICKETS.reopened]);
      res = await queue(USERS.tara, t, '&createdTo=2026-03-03T00:00:00Z');
      expect(ids(res)).toEqual([TICKETS.vpn]);
    });

    it('rejects malformed or contradictory filters', async () => {
      const t = TEAMS.network;
      for (const qs of [
        '&status=NOPE',
        '&priority=URGENT',
        '&categoryId=nope',
        '&createdFrom=yesterday',
        '&createdFrom=2026-04-01T00:00:00Z&createdTo=2026-03-01T00:00:00Z',
        '&limit=0',
        '&limit=101',
        '&offset=-1',
      ]) {
        expect((await queue(USERS.tara, t, qs)).statusCode, qs).toBe(400);
      }
    });

    it('limits the view to my own tickets with mine=true', async () => {
      const res = await queue(USERS.tom, TEAMS.network, '&mine=true');
      expect(ids(res)).toEqual([TICKETS.license]);
      expect(ids(await queue(USERS.tara, TEAMS.network, '&mine=true'))).toEqual([]);
    });

    it('pages without gaps or repeats and reports counts that match', async () => {
      for (let i = 1; i <= 5; i++) {
        await mk(i, 'MEDIUM', `2026-02-0${i}T00:00:00Z`, { assigned_team_id: TEAMS.hardware });
      }
      const seen: string[] = [];
      let offset = 0;
      for (;;) {
        const body = (await queue(USERS.hana, TEAMS.hardware, `&limit=2&offset=${offset}`)).json()
          .data as Page;
        expect(body.total).toBe(6);
        seen.push(...body.items.map((i) => i.id));
        if (body.nextOffset === null) break;
        expect(body.nextOffset).toBe(offset + 2);
        offset = body.nextOffset;
      }
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
      const whole = ids(await queue(USERS.hana, TEAMS.hardware, '&limit=100'));
      expect(seen).toEqual(whole);
    });

    it('reports age in minutes from the database clock', async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000);
      await mk(1, 'LOW', fiveHoursAgo.toISOString(), { assigned_team_id: TEAMS.hardware });
      const item = (await queue(USERS.hana, TEAMS.hardware))
        .json()
        .data.items.find((i: Item) => i.id === uuid('ticket', 201));
      expect(item.ageMinutes).toBeGreaterThanOrEqual(299);
      expect(item.ageMinutes).toBeLessThanOrEqual(302);
    });
  });

  describe('unassigned backlog', () => {
    it('lists OPEN tickets with no team, oldest first, with age', async () => {
      const res = await unassigned(USERS.tara);
      expect(ids(res)).toEqual([
        TICKETS.printer,
        TICKETS.aiDown,
        TICKETS.token,
        TICKETS.afterWindow,
      ]);
      expect(res.json().data.total).toBe(4);
      for (const item of res.json().data.items) {
        expect(item.assignee).toBeNull();
        expect(item.ageMinutes).toBeGreaterThan(0);
      }
    });

    it('is the same for every triager, whichever team they belong to', async () => {
      const a = ids(await unassigned(USERS.tara));
      expect(ids(await unassigned(USERS.hana))).toEqual(a);
      expect(ids(await unassigned(USERS.admin))).toEqual(a);
    });

    it('returns an empty page for an empty backlog', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE tickets SET assigned_team_id = '${TEAMS.network}' WHERE assigned_team_id IS NULL AND status = 'OPEN'`,
      );
      const res = await unassigned(USERS.tara);
      expect(res.json().data).toMatchObject({ items: [], total: 0, nextOffset: null });
    });

    it('can sort by priority and filter by priority, category and date', async () => {
      await mk(1, 'CRITICAL', '2026-03-20T00:00:00Z');
      await mk(2, 'LOW', '2026-03-20T00:00:00Z', { category_id: CATEGORIES.network });
      expect(ids(await unassigned(USERS.tara, '?sort=priority'))[0]).toBe(uuid('ticket', 201));
      expect(ids(await unassigned(USERS.tara, '?priority=CRITICAL,LOW'))).toEqual([
        uuid('ticket', 201),
        uuid('ticket', 202),
      ]);
      expect(ids(await unassigned(USERS.tara, `?categoryId=${CATEGORIES.network}`))).toEqual([
        uuid('ticket', 202),
      ]);
      expect(ids(await unassigned(USERS.tara, '?createdFrom=2026-03-15T00:00:00Z'))).toEqual([
        uuid('ticket', 201),
        uuid('ticket', 202),
        TICKETS.afterWindow,
      ]);
      expect((await unassigned(USERS.tara, '?teamId=x')).statusCode).toBe(400);
      expect((await unassigned(USERS.tara, '?status=OPEN')).statusCode).toBe(400);
    });
  });

  describe('routing moves tickets between queues', () => {
    it('removes a ticket from the backlog and shows it in the team queue', async () => {
      const before = (await unassigned(USERS.tara)).json().data.total;
      const hardwareBefore = (await queue(USERS.hana, TEAMS.hardware)).json().data.total;
      await prisma.ticket.update({
        where: { id: TICKETS.printer },
        data: {
          assignedTeamId: TEAMS.hardware,
          categoryId: CATEGORIES.hardware,
          priority: 'CRITICAL',
          status: 'TRIAGED',
          version: { increment: 1 },
        },
      });
      expect((await unassigned(USERS.tara)).json().data.total).toBe(before - 1);
      expect(ids(await unassigned(USERS.tara))).not.toContain(TICKETS.printer);
      const res = await queue(USERS.hana, TEAMS.hardware);
      expect(res.json().data.total).toBe(hardwareBefore + 1);
      expect(ids(res)[0]).toBe(TICKETS.printer);
      // The other team does not see it.
      expect(ids(await queue(USERS.tara, TEAMS.network))).not.toContain(TICKETS.printer);
    });

    it('moves a ticket between team queues on reassignment', async () => {
      await prisma.ticket.update({
        where: { id: TICKETS.reopened },
        data: { assignedTeamId: TEAMS.hardware },
      });
      expect(ids(await queue(USERS.tara, TEAMS.network))).not.toContain(TICKETS.reopened);
      expect(ids(await queue(USERS.hana, TEAMS.hardware))).toContain(TICKETS.reopened);
    });
  });
});
