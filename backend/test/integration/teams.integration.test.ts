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

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

describe.skipIf(!testDatabaseUrl)('support teams and membership (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (as: string | null, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, headers: as ? await bearer(as) : {}, payload });
  const admin = (method: Method, url: string, payload?: object) =>
    call(USERS.admin, method, `/api/admin/teams${url}`, payload);
  const memberIds = async (teamId: string) =>
    (await prisma.teamMember.findMany({ where: { teamId } })).map((m) => m.userId).sort();
  const newTechnician = (email = 'new.tech@smartdesk.test', over: object = {}) =>
    prisma.user.create({
      data: {
        email,
        displayName: 'New Tech',
        role: 'TECHNICIAN',
        ...over,
      },
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

  describe('role matrix', () => {
    const adminEndpoints = [
      ['GET', '/'],
      ['POST', '/'],
      ['GET', `/${TEAMS.network}`],
      ['PATCH', `/${TEAMS.network}`],
      ['POST', `/${TEAMS.network}/activate`],
      ['POST', `/${TEAMS.network}/deactivate`],
      ['GET', `/${TEAMS.network}/members`],
      ['POST', `/${TEAMS.network}/members`],
      ['DELETE', `/${TEAMS.network}/members/${USERS.tara}`],
    ] as const;

    it.each(adminEndpoints)('anonymous %s %s is 401', async (method, url) => {
      expect((await call(null, method, `/api/admin/teams${url}`, {})).statusCode).toBe(401);
    });

    it.each(adminEndpoints)(
      'employee and technician %s %s are 403 and change nothing',
      async (method, url) => {
        for (const who of [USERS.erin, USERS.tara]) {
          const res = await call(who, method, `/api/admin/teams${url}`, {
            name: 'Hijack',
            userId: USERS.hana,
          });
          expect(res.statusCode).toBe(403);
        }
        expect(await prisma.supportTeam.count()).toBe(3);
        expect(await memberIds(TEAMS.network)).toEqual([USERS.tara, USERS.tom].sort());
      },
    );

    it('employees cannot read the staff reference lists; staff and admins can', async () => {
      for (const url of ['/api/teams', '/api/categories', `/api/teams/${TEAMS.network}/members`]) {
        expect((await call(null, 'GET', url)).statusCode).toBe(401);
        expect((await call(USERS.erin, 'GET', url)).statusCode).toBe(403);
        expect((await call(USERS.tara, 'GET', url)).statusCode).toBe(200);
        expect((await call(USERS.admin, 'GET', url)).statusCode).toBe(200);
      }
    });
  });

  describe('reference lists', () => {
    it('lists only active teams, with no member or account details', async () => {
      const res = await call(USERS.tara, 'GET', '/api/teams');
      const teams = res.json().data as Array<Record<string, unknown>>;
      expect(teams.map((t) => t.id).sort()).toEqual([TEAMS.network, TEAMS.hardware].sort());
      expect(Object.keys(teams[0]!).sort()).toEqual(['description', 'id', 'name']);
    });

    it('limits the list to my own teams with mine=true (technicians) but not for admins', async () => {
      const ids = async (as: string, qs: string) =>
        ((await call(as, 'GET', `/api/teams${qs}`)).json().data as Array<{ id: string }>)
          .map((t) => t.id)
          .sort();
      expect(await ids(USERS.tara, '?mine=true')).toEqual([TEAMS.network]);
      expect(await ids(USERS.tom, '?mine=true')).toEqual([TEAMS.network, TEAMS.hardware].sort());
      expect(await ids(USERS.admin, '?mine=true')).toHaveLength(2);
      expect((await call(USERS.tara, 'GET', '/api/teams?mine=maybe')).statusCode).toBe(400);
    });

    it('lists only active categories', async () => {
      const res = await call(USERS.tara, 'GET', '/api/categories');
      const ids = (res.json().data as Array<{ id: string }>).map((c) => c.id);
      expect(ids).not.toContain(CATEGORIES.legacy);
      expect(ids).toHaveLength(4);
    });

    it('lists assignable members as id and display name only, excluding inactive accounts', async () => {
      await prisma.user.update({ where: { id: USERS.tom }, data: { isActive: false } });
      const res = await call(USERS.tara, 'GET', `/api/teams/${TEAMS.network}/members`);
      const members = res.json().data as Array<Record<string, unknown>>;
      expect(members.map((m) => m.id)).toEqual([USERS.tara]);
      expect(Object.keys(members[0]!).sort()).toEqual(['displayName', 'id']);
    });

    it('a technician can see the members of another active team (reassignment target)', async () => {
      const res = await call(USERS.tara, 'GET', `/api/teams/${TEAMS.hardware}/members`);
      expect(res.statusCode).toBe(200);
      expect((res.json().data as unknown[]).length).toBe(2);
    });

    it('hides inactive and unknown teams from the member list with 404', async () => {
      expect((await call(USERS.tara, 'GET', `/api/teams/${TEAMS.legacy}/members`)).statusCode).toBe(
        404,
      );
      expect(
        (await call(USERS.tara, 'GET', '/api/teams/00000000-0000-4000-8000-000000000000/members'))
          .statusCode,
      ).toBe(404);
      expect((await call(USERS.tara, 'GET', '/api/teams/not-a-uuid/members')).statusCode).toBe(400);
    });
  });

  describe('team CRUD', () => {
    it('creates, renames and describes a team', async () => {
      const created = await admin('POST', '/', { name: '  Security  ', description: 'Incidents' });
      expect(created.statusCode).toBe(201);
      const team = created.json().data;
      expect(team).toMatchObject({
        name: 'Security',
        description: 'Incidents',
        isActive: true,
        memberCount: 0,
      });

      const renamed = await admin('PATCH', `/${team.id}`, { name: 'SecOps' });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().data).toMatchObject({ name: 'SecOps', description: 'Incidents' });

      const cleared = await admin('PATCH', `/${team.id}`, { description: null });
      expect(cleared.json().data.description).toBeNull();
    });

    it('rejects duplicate names, blank names, unknown fields and empty patches', async () => {
      expect((await admin('POST', '/', { name: 'Network & Access' })).statusCode).toBe(409);
      expect((await admin('POST', '/', { name: '   ' })).statusCode).toBe(400);
      expect((await admin('POST', '/', { name: 'X', isActive: false })).statusCode).toBe(400);
      expect((await admin('PATCH', `/${TEAMS.network}`, {})).statusCode).toBe(400);
      expect(
        (await admin('PATCH', `/${TEAMS.network}`, { name: 'Hardware & Devices' })).statusCode,
      ).toBe(409);
      expect(
        (await admin('PATCH', `/${TEAMS.network}`, { name: 'Network & Access' })).statusCode,
      ).toBe(200);
      expect((await admin('GET', '/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    });

    it('lists every team, inactive ones included, with member counts', async () => {
      const teams = (await admin('GET', '/')).json().data as Array<{
        id: string;
        isActive: boolean;
        memberCount: number;
      }>;
      expect(teams).toHaveLength(3);
      expect(teams.find((t) => t.id === TEAMS.network)).toMatchObject({
        isActive: true,
        memberCount: 2,
      });
      expect(teams.find((t) => t.id === TEAMS.legacy)).toMatchObject({
        isActive: false,
        memberCount: 1,
      });
    });

    it('deactivates and reactivates idempotently, keeping members and ticket history', async () => {
      const before = await prisma.ticket.count({ where: { assignedTeamId: TEAMS.network } });
      expect(before).toBeGreaterThan(0);

      for (let i = 0; i < 2; i++) {
        const res = await admin('POST', `/${TEAMS.network}/deactivate`);
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toMatchObject({ isActive: false, memberCount: 2 });
      }
      expect(await prisma.ticket.count({ where: { assignedTeamId: TEAMS.network } })).toBe(before);
      expect((await call(USERS.tara, 'GET', '/api/teams')).json().data).toHaveLength(1);

      const res = await admin('POST', `/${TEAMS.network}/activate`);
      expect(res.json().data.isActive).toBe(true);
    });

    it('exposes no way to delete a team', async () => {
      expect((await admin('DELETE', `/${TEAMS.network}`)).statusCode).toBe(404);
      expect(await prisma.supportTeam.count()).toBe(3);
    });
  });

  describe('membership', () => {
    it('adds an active technician and lists them with email and ticket counts', async () => {
      const tech = await newTechnician();
      const res = await admin('POST', `/${TEAMS.hardware}/members`, { userId: tech.id });
      expect(res.statusCode).toBe(201);
      expect(res.json().data).toMatchObject({
        id: tech.id,
        email: 'new.tech@smartdesk.test',
        isActive: true,
        assignedTicketCount: 0,
      });
      expect(await memberIds(TEAMS.hardware)).toContain(tech.id);
    });

    it('lets a technician belong to several teams and see both queues in their principal', async () => {
      // Tom is seeded in Network and Hardware; Tara joins Hardware as well.
      expect(
        (await admin('POST', `/${TEAMS.hardware}/members`, { userId: USERS.tara })).statusCode,
      ).toBe(201);
      const memberships = await prisma.teamMember.findMany({ where: { userId: USERS.tara } });
      expect(memberships.map((m) => m.teamId).sort()).toEqual(
        [TEAMS.network, TEAMS.hardware].sort(),
      );
    });

    it.each([
      ['an employee', USERS.erin],
      ['an administrator', USERS.admin],
      ['an inactive technician', USERS.ingrid],
    ])('refuses to add %s with 409', async (_label, userId) => {
      const before = await memberIds(TEAMS.hardware);
      const res = await admin('POST', `/${TEAMS.hardware}/members`, { userId });
      expect(res.statusCode).toBe(409);
      expect(await memberIds(TEAMS.hardware)).toEqual(before);
    });

    it('refuses to add members to an inactive team and refuses duplicates', async () => {
      expect(
        (await admin('POST', `/${TEAMS.legacy}/members`, { userId: USERS.hana })).statusCode,
      ).toBe(409);
      expect(await memberIds(TEAMS.legacy)).toEqual([USERS.ingrid]);
      expect(
        (await admin('POST', `/${TEAMS.hardware}/members`, { userId: USERS.hana })).statusCode,
      ).toBe(409);
    });

    it('404s unknown teams and users, 400s malformed bodies', async () => {
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect((await admin('POST', `/${unknown}/members`, { userId: USERS.hana })).statusCode).toBe(
        404,
      );
      expect(
        (await admin('POST', `/${TEAMS.hardware}/members`, { userId: unknown })).statusCode,
      ).toBe(404);
      expect(
        (await admin('POST', `/${TEAMS.hardware}/members`, { userId: 'nope' })).statusCode,
      ).toBe(400);
      expect(
        (await admin('POST', `/${TEAMS.hardware}/members`, { userId: USERS.hana, role: 'ADMIN' }))
          .statusCode,
      ).toBe(400);
    });

    it('removes a member who has no tickets in the team', async () => {
      const tech = await newTechnician();
      await admin('POST', `/${TEAMS.hardware}/members`, { userId: tech.id });
      const res = await admin('DELETE', `/${TEAMS.hardware}/members/${tech.id}`);
      expect(res.statusCode).toBe(200);
      expect(await memberIds(TEAMS.hardware)).not.toContain(tech.id);
      expect((await admin('DELETE', `/${TEAMS.hardware}/members/${tech.id}`)).statusCode).toBe(404);
    });

    it('a removed member loses every read path to the team’s tickets with an existing token', async () => {
      const tech = await newTechnician();
      await admin('POST', `/${TEAMS.network}/members`, { userId: tech.id });
      // Issued while still a member: scope must come from the server on every request.
      const headers = await bearer(tech.id);
      const get = (url: string) => app.inject({ url, headers });
      const reads = ['', '/events', '/comments', '/recommendations', '/analysis'].map(
        (suffix) => `/api/tickets/${TICKETS.vpn}${suffix}`,
      );
      const queue = `/api/technician/queue?teamId=${TEAMS.network}`;
      for (const url of reads) expect((await get(url)).statusCode, url).toBe(200);
      expect((await get('/api/tickets')).body).toContain(TICKETS.vpn);
      expect((await get(queue)).statusCode).toBe(200);

      expect((await admin('DELETE', `/${TEAMS.network}/members/${tech.id}`)).statusCode).toBe(200);

      for (const url of reads) expect((await get(url)).statusCode, url).toBe(404);
      expect((await get('/api/tickets')).body).not.toContain(TICKETS.vpn);
      expect((await get(queue)).statusCode).toBe(403);
      const comment = await app.inject({
        method: 'POST',
        url: `/api/tickets/${TICKETS.vpn}/comments`,
        headers,
        payload: { body: 'Still here?', isInternal: true },
      });
      expect(comment.statusCode).toBe(404);
    });

    it('refuses to remove a member with assigned tickets and leaves history intact', async () => {
      const assigned = await prisma.ticket.findMany({
        where: { assignedTeamId: { not: null }, assigneeId: { not: null } },
        select: { id: true, assignedTeamId: true, assigneeId: true },
      });
      expect(assigned.length).toBeGreaterThan(0);
      const { assignedTeamId, assigneeId } = assigned[0]!;

      const res = await admin('DELETE', `/${assignedTeamId}/members/${assigneeId}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().details.assignedTicketCount).toBeGreaterThan(0);
      expect(await memberIds(assignedTeamId!)).toContain(assigneeId);
      expect(
        await prisma.ticket.findUniqueOrThrow({ where: { id: assigned[0]!.id } }),
      ).toMatchObject({
        assignedTeamId,
        assigneeId,
      });
    });

    it('removal is scoped to one team: Tom has a ticket in Network but none in Hardware', async () => {
      expect((await admin('DELETE', `/${TEAMS.network}/members/${USERS.tom}`)).statusCode).toBe(
        409,
      );
      expect((await admin('DELETE', `/${TEAMS.hardware}/members/${USERS.tom}`)).statusCode).toBe(
        200,
      );
      expect(await memberIds(TEAMS.hardware)).toEqual([USERS.hana]);
      expect(await memberIds(TEAMS.network)).toContain(USERS.tom);
    });

    it('reports per-member ticket counts in the admin member list', async () => {
      const members = (await admin('GET', `/${TEAMS.network}/members`)).json().data as Array<{
        id: string;
        assignedTicketCount: number;
      }>;
      const expected = await prisma.ticket.count({
        where: { assignedTeamId: TEAMS.network, assigneeId: USERS.tom },
      });
      expect(members.find((m) => m.id === USERS.tom)!.assignedTicketCount).toBe(expected);
    });

    it('a team deactivation does not touch tickets assigned to it', async () => {
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.license } });
      expect(ticket.assignedTeamId).toBe(TEAMS.network);
      await admin('POST', `/${TEAMS.network}/deactivate`);
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(after.assignedTeamId).toBe(ticket.assignedTeamId);
      expect(after.assigneeId).toBe(ticket.assigneeId);
    });
  });
});
