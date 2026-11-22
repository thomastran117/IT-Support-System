import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { canReadTicket } from '../../src/auth/policies.js';
import * as policy from '../../src/auth/policies.js';
import { authorizeTicket, ticketReadFilter } from '../../src/auth/ticketAccess.js';
import type { Principal } from '../../src/auth/guard.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

const ALL_TICKETS = Object.values(TICKETS).filter(
  (t) => t !== TICKETS.demoA && t !== TICKETS.demoB,
);
const MISSING = '00000000-0000-4000-8000-0000000000ff';

describe.skipIf(!testDatabaseUrl)('RBAC and record-level policies (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (
    userId: string | null,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/t${url}`,
      headers: userId ? await bearer(userId) : {},
      payload,
    });

  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });

    // Stand-in routes (the real ones arrive in epic E03) that use only the shared guards/policies.
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
      logger: false,
      extraRoutes: (scope) => {
        const { requireAuth, requireRole } = scope.authGuards;
        const id = (req: { params: unknown }) => (req.params as { id: string }).id;
        const me = (req: { principal?: Principal }) => req.principal!;

        scope.get('/t/tickets', { preHandler: requireAuth }, async (req) => ({
          ids: (
            await prisma.ticket.findMany({ where: ticketReadFilter(me(req)), select: { id: true } })
          ).map((t) => t.id),
        }));
        scope.get('/t/tickets/:id', { preHandler: requireAuth }, async (req) => {
          const t = await authorizeTicket(prisma, me(req), id(req), 'read');
          return { id: t.id };
        });
        scope.patch('/t/tickets/:id', { preHandler: requireAuth }, async (req) => {
          const t = await authorizeTicket(prisma, me(req), id(req), 'edit');
          return { id: t.id, edited: true };
        });
        scope.get('/t/tickets/:id/comments', { preHandler: requireAuth }, async (req) => {
          const t = await authorizeTicket(prisma, me(req), id(req), 'read');
          const rows = await prisma.ticketComment.findMany({
            where: {
              ticketId: t.id,
              ...(policy.canSeeInternalNotes(me(req), t) ? {} : { isInternal: false }),
            },
            select: { body: true, isInternal: true },
          });
          return { comments: rows };
        });
        scope.post('/t/tickets/:id/comments', { preHandler: requireAuth }, async (req, reply) => {
          const t = await authorizeTicket(prisma, me(req), id(req), 'read');
          const { isInternal } = req.body as { isInternal?: boolean };
          if (isInternal && !policy.canAuthorInternalNote(me(req), t)) {
            return reply.code(403).send({ error: 'Forbidden' });
          }
          return { ok: true };
        });
        scope.get('/t/tickets/:id/audit', { preHandler: requireAuth }, async (req, reply) => {
          const t = await authorizeTicket(prisma, me(req), id(req), 'read');
          if (!policy.canViewRawAudit(me(req), t))
            return reply.code(403).send({ error: 'Forbidden' });
          return { events: await prisma.ticketEvent.count({ where: { ticketId: t.id } }) };
        });
        scope.get('/t/admin/analytics', { preHandler: requireRole('ADMIN') }, async () => ({
          ok: 1,
        }));
        scope.post('/t/admin/labels', { preHandler: requireRole('ADMIN') }, async () => ({
          ok: 1,
        }));
        scope.get('/t/admin/users', { preHandler: requireRole('ADMIN') }, async () => ({ ok: 1 }));
        scope.get('/t/staff', { preHandler: requireRole('TECHNICIAN', 'ADMIN') }, async () => ({
          ok: 1,
        }));
      },
    });
  });
  afterEach(async () => {
    // Restore anything a test changed.
    await prisma.user.updateMany({ data: { tokenVersion: 0 } });
    await prisma.user.update({ where: { id: USERS.omar }, data: { role: 'EMPLOYEE' } });
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  describe('authentication on every protected route', () => {
    it.each([
      ['GET', `/tickets`],
      ['GET', `/tickets/${TICKETS.vpn}`],
      ['PATCH', `/tickets/${TICKETS.vpn}`],
      ['GET', `/tickets/${TICKETS.vpn}/comments`],
      ['GET', `/tickets/${TICKETS.vpn}/audit`],
      ['GET', '/admin/analytics'],
      ['GET', '/staff'],
    ] as const)('anonymous %s %s is 401', async (method, url) => {
      expect((await call(null, method, url)).statusCode).toBe(401);
    });
  });

  describe('employee ownership', () => {
    it('lists, reads and comments only on their own tickets', async () => {
      const list = (await call(USERS.erin, 'GET', '/tickets')).json().ids as string[];
      const own = await prisma.ticket.findMany({ where: { requesterId: USERS.erin } });
      expect(new Set(list)).toEqual(new Set(own.map((t) => t.id)));
      expect((await call(USERS.erin, 'GET', `/tickets/${TICKETS.vpn}`)).statusCode).toBe(200);
    });

    it("another employee's ticket is 404 on read, edit, comments, audit (direct-ID guess)", async () => {
      for (const [method, path] of [
        ['GET', ''],
        ['PATCH', ''],
        ['GET', '/comments'],
        ['POST', '/comments'],
        ['GET', '/audit'],
      ] as const) {
        const res = await call(USERS.erin, method, `/tickets/${TICKETS.license}${path}`, {});
        expect(res.statusCode, `${method} ${path}`).toBe(404);
      }
    });

    it('denial is indistinguishable from a ticket that does not exist', async () => {
      const denied = await call(USERS.erin, 'GET', `/tickets/${TICKETS.license}`);
      const missing = await call(USERS.erin, 'GET', `/tickets/${MISSING}`);
      const malformed = await call(USERS.erin, 'GET', `/tickets/not-a-uuid`);
      for (const r of [denied, missing, malformed]) expect(r.statusCode).toBe(404);
      expect(denied.json()).toEqual(missing.json());
      expect(denied.json()).toEqual(malformed.json());
    });

    it('cannot edit even their own ticket (403, not 404: they may see it)', async () => {
      expect((await call(USERS.erin, 'PATCH', `/tickets/${TICKETS.vpn}`)).statusCode).toBe(403);
    });

    it('never sees internal notes, and cannot author one', async () => {
      const own = (await call(USERS.erin, 'GET', `/tickets/${TICKETS.vpn}/comments`)).json();
      expect(own.comments.length).toBeGreaterThan(0);
      expect(own.comments.every((c: { isInternal: boolean }) => !c.isInternal)).toBe(true);
      expect(JSON.stringify(own)).not.toContain('certificate expires hourly');
      const post = await call(USERS.erin, 'POST', `/tickets/${TICKETS.vpn}/comments`, {
        isInternal: true,
      });
      expect(post.statusCode).toBe(403);
      expect(
        (await call(USERS.erin, 'POST', `/tickets/${TICKETS.vpn}/comments`, {})).statusCode,
      ).toBe(200);
    });

    it('cannot read raw audit data for their own ticket', async () => {
      expect((await call(USERS.erin, 'GET', `/tickets/${TICKETS.vpn}/audit`)).statusCode).toBe(403);
    });
  });

  describe('technician scope', () => {
    it('works network tickets, hides hardware ones; tom (both teams) reaches both', async () => {
      // vpn: Network team, requested by erin
      expect((await call(USERS.tara, 'PATCH', `/tickets/${TICKETS.vpn}`)).statusCode).toBe(200);
      // monitor: Hardware team: outside tara's scope
      for (const [m, p] of [
        ['GET', ''],
        ['PATCH', ''],
        ['GET', '/comments'],
        ['GET', '/audit'],
      ] as const) {
        expect((await call(USERS.tara, m, `/tickets/${TICKETS.monitor}${p}`)).statusCode).toBe(404);
      }
      expect((await call(USERS.tom, 'PATCH', `/tickets/${TICKETS.monitor}`)).statusCode).toBe(200);
      expect((await call(USERS.hana, 'PATCH', `/tickets/${TICKETS.vpn}`)).statusCode).toBe(404);
    });

    it('can triage the shared unrouted backlog', async () => {
      expect((await call(USERS.tara, 'PATCH', `/tickets/${TICKETS.printer}`)).statusCode).toBe(200);
      expect((await call(USERS.hana, 'PATCH', `/tickets/${TICKETS.aiDown}`)).statusCode).toBe(200);
    });

    it('sees internal notes and raw audit data inside their scope only', async () => {
      const c = (await call(USERS.tara, 'GET', `/tickets/${TICKETS.vpn}/comments`)).json();
      expect(c.comments.some((x: { isInternal: boolean }) => x.isInternal)).toBe(true);
      expect((await call(USERS.tara, 'GET', `/tickets/${TICKETS.vpn}/audit`)).statusCode).toBe(200);
      expect(
        (await call(USERS.tara, 'POST', `/tickets/${TICKETS.vpn}/comments`, { isInternal: true }))
          .statusCode,
      ).toBe(200);
    });

    it('technician lists contain exactly their teams plus the unrouted backlog', async () => {
      const ids = (await call(USERS.hana, 'GET', '/tickets')).json().ids as string[];
      const rows = await prisma.ticket.findMany({
        where: {
          OR: [
            { assignedTeamId: TEAMS.hardware },
            { assignedTeamId: null },
            { requesterId: USERS.hana },
          ],
        },
      });
      expect(new Set(ids)).toEqual(new Set(rows.map((t) => t.id)));
      expect(ids).not.toContain(TICKETS.vpn);
    });
  });

  describe('admin-only operations', () => {
    it.each([
      ['GET', '/admin/analytics'],
      ['POST', '/admin/labels'],
      ['GET', '/admin/users'],
    ] as const)('%s %s: admin 200, everyone else 403', async (method, url) => {
      expect((await call(USERS.admin, method, url, {})).statusCode).toBe(200);
      for (const u of [USERS.erin, USERS.tara, USERS.tom]) {
        expect((await call(u, method, url, {})).statusCode).toBe(403);
      }
    });

    it('role guard for staff admits technicians and admins but not employees', async () => {
      expect((await call(USERS.tara, 'GET', '/staff')).statusCode).toBe(200);
      expect((await call(USERS.admin, 'GET', '/staff')).statusCode).toBe(200);
      expect((await call(USERS.erin, 'GET', '/staff')).statusCode).toBe(403);
    });

    it('admins can read and edit every ticket', async () => {
      for (const id of ALL_TICKETS) {
        expect((await call(USERS.admin, 'GET', `/tickets/${id}`)).statusCode).toBe(200);
        expect((await call(USERS.admin, 'PATCH', `/tickets/${id}`)).statusCode).toBe(200);
      }
    });
  });

  describe('privileges are re-read from the server on every request', () => {
    it('a role change applies to a token issued before it', async () => {
      const before = await call(USERS.omar, 'GET', '/admin/analytics');
      expect(before.statusCode).toBe(403);
      await prisma.user.update({ where: { id: USERS.omar }, data: { role: 'ADMIN' } });
      expect((await call(USERS.omar, 'GET', '/admin/analytics')).statusCode).toBe(200);
      await prisma.user.update({ where: { id: USERS.omar }, data: { role: 'EMPLOYEE' } });
      expect((await call(USERS.omar, 'GET', '/admin/analytics')).statusCode).toBe(403);
    });

    it('deactivating a technician’s team removes their access at once', async () => {
      const url = `/tickets/${TICKETS.vpn}`;
      expect((await call(USERS.tara, 'GET', url)).statusCode).toBe(200);
      await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: false } });
      try {
        expect((await call(USERS.tara, 'GET', url)).statusCode).toBe(404);
      } finally {
        await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: true } });
      }
    });

    it('a technician in no active team has no scope, not even the shared backlog', async () => {
      await prisma.supportTeam.update({ where: { id: TEAMS.hardware }, data: { isActive: false } });
      try {
        const res = await call(USERS.hana, 'GET', `/tickets/${TICKETS.printer}`);
        expect(res.statusCode).toBe(404);
      } finally {
        await prisma.supportTeam.update({
          where: { id: TEAMS.hardware },
          data: { isActive: true },
        });
      }
    });

    it('a token_version bump or deactivation locks the user out immediately', async () => {
      const headers = await bearer(USERS.admin);
      await prisma.user.update({ where: { id: USERS.admin }, data: { tokenVersion: 1 } });
      const res = await app.inject({ url: '/api/t/admin/analytics', headers });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('list filter and read policy agree for every user × ticket', () => {
    it('ticketReadFilter returns exactly the tickets canReadTicket allows', async () => {
      const all = await prisma.ticket.findMany({
        select: { id: true, requesterId: true, assignedTeamId: true },
      });
      for (const userId of Object.values(USERS)) {
        const u = await prisma.user.findUniqueOrThrow({
          where: { id: userId },
          include: {
            teamMemberships: { where: { team: { isActive: true } }, select: { teamId: true } },
          },
        });
        const p: Principal = {
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role as Principal['role'],
          teamIds: u.teamMemberships.map((m) => m.teamId),
        };
        const viaFilter = (
          await prisma.ticket.findMany({ where: ticketReadFilter(p), select: { id: true } })
        )
          .map((t) => t.id)
          .sort();
        const viaPolicy = all
          .filter((t) => canReadTicket(p, t))
          .map((t) => t.id)
          .sort();
        expect(viaFilter, u.email).toEqual(viaPolicy);
      }
    });
  });
});
