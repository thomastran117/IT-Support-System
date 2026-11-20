import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../src/db/errors.js';
import {
  getTicketAudit,
  listEmployeeTickets,
  listTeamQueue,
  listUnassignedBacklog,
} from '../../src/db/repositories/operationalQueries.js';
import { loadSql, MAX_PAGE_SIZE, normalizePage, paginated } from '../../src/db/sql.js';
import { CATEGORIES, TEAMS, TICKETS, USERS, uuid } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, insertRow, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('operational queries Q01-Q04 (integration)', () => {
  const prisma = createTestPrisma();

  beforeAll(async () => {
    await seedDatabase(prisma, { profile: 'test', reset: true, databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  const ids = <T extends { ticketId: string }>(rows: T[]) => rows.map((r) => r.ticketId);
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(DbError);
      return (err as DbError).code;
    }
    throw new Error('expected a rejection');
  };

  describe('Q01 employee ticket history', () => {
    it("returns only the caller's tickets, newest first", async () => {
      const erin = await listEmployeeTickets(prisma, USERS.erin);
      expect(ids(erin)).toEqual([
        TICKETS.afterWindow, // 04-01
        TICKETS.token, // 03-09 15:00
        TICKETS.reopened, // 03-06
        TICKETS.password, // 03-04
        TICKETS.vpn, // 03-02 14:00
        TICKETS.printer, // 03-02 09:00
      ]);
      expect(erin[0]).toMatchObject({
        title: 'Request a second keyboard',
        status: 'OPEN',
        priority: 'UNSET',
      });

      const omar = await listEmployeeTickets(prisma, USERS.omar);
      expect(ids(omar)).toEqual([
        TICKETS.aiDown, // 03-09
        TICKETS.monitor, // 03-05
        TICKETS.license, // 03-03
        TICKETS.boundary, // 03-01
      ]);
    });

    it('returns an empty list for someone with no tickets', async () => {
      expect(await listEmployeeTickets(prisma, USERS.admin)).toEqual([]);
    });

    it('rejects inactive or unknown callers', async () => {
      expect(await code(listEmployeeTickets(prisma, USERS.ivan))).toBe('FORBIDDEN');
      expect(await code(listEmployeeTickets(prisma, uuid('user', 999)))).toBe('FORBIDDEN');
    });

    it('paginates stably and caps the page size', async () => {
      const all = ids(await listEmployeeTickets(prisma, USERS.erin));
      const p1 = ids(await listEmployeeTickets(prisma, USERS.erin, { limit: 2, offset: 0 }));
      const p2 = ids(await listEmployeeTickets(prisma, USERS.erin, { limit: 2, offset: 2 }));
      const p3 = ids(await listEmployeeTickets(prisma, USERS.erin, { limit: 2, offset: 4 }));
      expect([...p1, ...p2, ...p3]).toEqual(all);
      expect(await listEmployeeTickets(prisma, USERS.erin, { limit: 2, offset: 50 })).toEqual([]);
      expect(normalizePage({ limit: 100000 }).limit).toBe(MAX_PAGE_SIZE);
      await expect(async () => normalizePage({ limit: 0 })).rejects.toBeInstanceOf(DbError);
      await expect(async () => normalizePage({ offset: -1 })).rejects.toBeInstanceOf(DbError);
    });
  });

  describe('Q02 team queue', () => {
    it('orders unresolved tickets by priority then age', async () => {
      const queue = await listTeamQueue(prisma, USERS.tara, TEAMS.network);
      // vpn HIGH; then MEDIUM oldest first: license (03-03), reopened (03-06).
      // password (RESOLVED) is excluded.
      expect(ids(queue)).toEqual([TICKETS.vpn, TICKETS.license, TICKETS.reopened]);
      expect(queue[1]).toMatchObject({
        priority: 'MEDIUM',
        status: 'IN_PROGRESS',
        assigneeId: USERS.tom,
      });
      expect(ids(await listTeamQueue(prisma, USERS.hana, TEAMS.hardware))).toEqual([
        TICKETS.boundary, // monitor is CLOSED
      ]);
    });

    it('sorts CRITICAL..LOW..UNSET and breaks ties by creation time then id', async () => {
      const mk = (n: number, priority: string, created: string, status = 'OPEN') =>
        insertRow(prisma, 'tickets', {
          ticket_id: uuid('ticket', 100 + n),
          requester_id: USERS.erin,
          title: `queue ${n}`,
          description: 'x',
          assigned_team_id: TEAMS.hardware,
          priority,
          status,
          category_id: priority === 'UNSET' ? null : CATEGORIES.hardware,
          created_at: new Date(created),
          updated_at: new Date(created),
        });
      try {
        await mk(1, 'UNSET', '2026-01-01T00:00:00Z');
        await mk(2, 'LOW', '2026-01-01T00:00:00Z');
        await mk(3, 'CRITICAL', '2026-02-01T00:00:00Z', 'TRIAGED');
        await mk(4, 'CRITICAL', '2026-02-01T00:00:00Z', 'TRIAGED'); // same time: id breaks the tie
        await mk(5, 'HIGH', '2026-02-02T00:00:00Z', 'TRIAGED');
        const queue = await listTeamQueue(prisma, USERS.hana, TEAMS.hardware);
        expect(ids(queue)).toEqual([
          uuid('ticket', 103),
          uuid('ticket', 104),
          uuid('ticket', 105),
          TICKETS.boundary, // MEDIUM
          uuid('ticket', 102), // LOW
          uuid('ticket', 101), // UNSET
        ]);
      } finally {
        await prisma.$executeRawUnsafe(
          `DELETE FROM tickets WHERE ticket_id = ANY($1::uuid[])`,
          [1, 2, 3, 4, 5].map((n) => uuid('ticket', 100 + n)),
        );
      }
    });

    it('lets admins and multi-team technicians in, and refuses everyone else', async () => {
      expect(ids(await listTeamQueue(prisma, USERS.admin, TEAMS.hardware))).toHaveLength(1);
      expect(ids(await listTeamQueue(prisma, USERS.tom, TEAMS.network))).toHaveLength(3);
      expect(ids(await listTeamQueue(prisma, USERS.tom, TEAMS.hardware))).toHaveLength(1);
      // Another team's queue, an employee, and an inactive technician are all refused.
      expect(await code(listTeamQueue(prisma, USERS.tara, TEAMS.hardware))).toBe('FORBIDDEN');
      expect(await code(listTeamQueue(prisma, USERS.hana, TEAMS.network))).toBe('FORBIDDEN');
      expect(await code(listTeamQueue(prisma, USERS.erin, TEAMS.network))).toBe('FORBIDDEN');
      expect(await code(listTeamQueue(prisma, USERS.ingrid, TEAMS.legacy))).toBe('FORBIDDEN');
    });

    it('returns nothing for an empty team queue', async () => {
      expect(await listTeamQueue(prisma, USERS.admin, TEAMS.legacy)).toEqual([]);
    });
  });

  describe('Q03 unassigned backlog', () => {
    it('lists OPEN tickets without a team, oldest first, with their age', async () => {
      const rows = await listUnassignedBacklog(prisma, USERS.tara);
      expect(ids(rows)).toEqual([
        TICKETS.printer,
        TICKETS.aiDown,
        TICKETS.token,
        TICKETS.afterWindow,
      ]);
      for (const row of rows) {
        const expected = (Date.now() - row.createdAt.getTime()) / 60_000;
        expect(row.ageMinutes).toBeGreaterThan(0);
        expect(Math.abs(row.ageMinutes - expected)).toBeLessThan(5);
      }
      expect(ids(await listUnassignedBacklog(prisma, USERS.hana))).toHaveLength(4);
      expect(ids(await listUnassignedBacklog(prisma, USERS.admin))).toHaveLength(4);
    });

    it('is staff only and paginates', async () => {
      expect(await code(listUnassignedBacklog(prisma, USERS.erin))).toBe('FORBIDDEN');
      const page = await listUnassignedBacklog(prisma, USERS.tara, { limit: 2, offset: 1 });
      expect(ids(page)).toEqual([TICKETS.aiDown, TICKETS.token]);
    });
  });

  describe('Q04 ticket audit', () => {
    it('returns the full ordered history to the ticket team, with the actor name', async () => {
      const rows = await getTicketAudit(prisma, USERS.tara, TICKETS.vpn);
      expect(rows.map((r) => r.eventType)).toEqual([
        'CREATED', // 14:00
        'COMMENT_ADDED', // 14:10 (Erin)
        'TEAM_ASSIGNED', // 14:30
        'AI_REVIEWED', // 14:30:30
        'STATUS_CHANGED', // 14:30:40
        'COMMENT_ADDED', // 14:35 (public)
        'COMMENT_ADDED', // 14:40 (internal)
      ]);
      expect(rows[0]).toMatchObject({ actor: 'Erin Employee' });
      expect(rows[2]).toMatchObject({ actor: 'Tara Technician' });
      expect(rows[2]!.details).toEqual({ from: null, to: TEAMS.network });
      expect(rows[6]!.details).toMatchObject({ isInternal: true });
    });

    it('keeps system events with a NULL actor', async () => {
      const rows = await getTicketAudit(prisma, USERS.admin, TICKETS.monitor);
      const last = rows.at(-1)!;
      expect(last).toMatchObject({ eventType: 'STATUS_CHANGED', actor: null });
      expect(last.details).toMatchObject({ to: 'CLOSED' });
    });

    it('gives the requester only the public, reduced history', async () => {
      const rows = await getTicketAudit(prisma, USERS.erin, TICKETS.vpn);
      expect(rows.map((r) => r.eventType)).toEqual([
        'CREATED',
        'COMMENT_ADDED', // 14:10 public
        'STATUS_CHANGED',
        'COMMENT_ADDED', // 14:35 public (first technician response)
      ]);
      const text = JSON.stringify(rows);
      expect(text).not.toContain('isInternal":true');
      expect(text).not.toContain(TEAMS.network); // no routing
      expect(text).not.toContain('recommendationId');
      expect(rows[2]!.details).toEqual({ from: 'OPEN', to: 'TRIAGED' });

      const closed = await getTicketAudit(prisma, USERS.omar, TICKETS.monitor);
      expect(JSON.stringify(closed)).not.toContain('auto-close'); // system reason is hidden
    });

    it('hides tickets the caller may not see behind the same 404 as a missing ticket', async () => {
      expect(await code(getTicketAudit(prisma, USERS.omar, TICKETS.vpn))).toBe('NOT_FOUND');
      expect(await code(getTicketAudit(prisma, USERS.hana, TICKETS.vpn))).toBe('NOT_FOUND');
      expect(await code(getTicketAudit(prisma, USERS.tara, uuid('ticket', 999)))).toBe('NOT_FOUND');
      expect(await code(getTicketAudit(prisma, USERS.ivan, TICKETS.vpn))).toBe('FORBIDDEN');
      // A technician may read an unassigned ticket's history; an admin may read any.
      expect(await getTicketAudit(prisma, USERS.hana, TICKETS.printer)).toHaveLength(1);
      expect(await getTicketAudit(prisma, USERS.admin, TICKETS.vpn)).toHaveLength(7);
    });

    it('orders events with identical timestamps by event id and paginates', async () => {
      const stamp = new Date('2026-03-02T09:00:00Z'); // same instant as printer's CREATED event
      const rows = [uuid('event', 901), uuid('event', 902), uuid('event', 903)];
      try {
        for (const id of [rows[2]!, rows[0]!, rows[1]!]) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO ticket_events (event_id, ticket_id, actor_id, event_type, occurred_at, details)
             VALUES ($1::uuid, $2::uuid, NULL, 'STATUS_CHANGED', $3::timestamptz, $4::jsonb)`,
            id,
            TICKETS.printer,
            stamp,
            JSON.stringify({ n: id.slice(-3) }),
          );
        }
        const audit = await getTicketAudit(prisma, USERS.admin, TICKETS.printer);
        // CREATED (event id 1) sorts before the 9xx events at the same instant.
        expect(audit.map((r) => (r.details as { n?: string }).n)).toEqual([
          undefined,
          '901',
          '902',
          '903',
        ]);
        const page = await getTicketAudit(prisma, USERS.admin, TICKETS.printer, {
          limit: 2,
          offset: 1,
        });
        expect(page.map((r) => (r.details as { n?: string }).n)).toEqual(['901', '902']);
      } finally {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE ticket_events DISABLE TRIGGER trg_ticket_events_append_only`,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM ticket_events WHERE event_id = ANY($1::uuid[])`,
          rows,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE ticket_events ENABLE TRIGGER trg_ticket_events_append_only`,
        );
      }
    });
  });

  describe('SQL files', () => {
    it('are stored verbatim and use bound parameters only', () => {
      for (const file of [
        'Q01_employee_ticket_history',
        'Q02_team_queue',
        'Q03_unassigned_backlog',
        'Q04_ticket_audit',
        'Q04_ticket_audit_requester',
      ]) {
        const sql = loadSql(`queries/${file}.sql`);
        expect(sql).toMatch(/^-- Q0\d/);
        expect(sql).not.toMatch(/\$\{|'\s*\+/); // no interpolation markers
      }
      expect(paginated('SELECT 1 ORDER BY 1;\n', 1)).toBe(
        'SELECT 1 ORDER BY 1 LIMIT $2::int OFFSET $3::int',
      );
    });
  });
});
