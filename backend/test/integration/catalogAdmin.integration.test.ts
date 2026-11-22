import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, TEAMS, TICKETS, USERS, uuid } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

describe.skipIf(!testDatabaseUrl)('category and team administration (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (as: string | null, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, headers: as ? await bearer(as) : {}, payload });
  const cat = (method: Method, url: string, payload?: object, as: string | null = USERS.admin) =>
    call(as, method, `/api/admin/categories${url}`, payload);
  const staffCategories = async (as = USERS.hana) =>
    (await call(as, 'GET', '/api/categories')).json().data as { id: string; name: string }[];

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

  describe('categories', () => {
    it('lists every category, inactive ones included, with how many tickets use it', async () => {
      const res = await cat('GET', '');
      expect(res.statusCode).toBe(200);
      const list = res.json().data as {
        id: string;
        name: string;
        isActive: boolean;
        ticketCount: number;
      }[];
      expect(list.map((c) => c.name)).toEqual([
        'Access/Accounts',
        'Hardware',
        'Network/VPN',
        'Software',
        expect.any(String),
      ]);
      const legacy = list.find((c) => c.id === CATEGORIES.legacy)!;
      expect(legacy.isActive).toBe(false);
      expect(list[list.length - 1]!.id).toBe(CATEGORIES.legacy); // inactive sort last
      for (const c of list) {
        const n = await prisma.ticket.count({ where: { categoryId: c.id } });
        expect(c.ticketCount).toBe(n);
      }
    });

    it('creates, renames and describes a category', async () => {
      const created = await cat('POST', '', { name: '  Security  ', description: 'Incidents' });
      expect(created.statusCode).toBe(201);
      const c = created.json().data;
      expect(c).toMatchObject({
        name: 'Security',
        description: 'Incidents',
        isActive: true,
        ticketCount: 0,
      });
      expect((await staffCategories()).map((x) => x.name)).toContain('Security');

      const renamed = await cat('PATCH', `/${c.id}`, { name: 'SecOps', description: null });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().data).toMatchObject({ name: 'SecOps', description: null });
    });

    it('explains duplicate names, case-insensitively unique by exact name only', async () => {
      const dup = await cat('POST', '', { name: 'Hardware' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().message).toMatch(/already exists/);
      const clash = await cat('PATCH', `/${CATEGORIES.software}`, { name: 'Hardware' });
      expect(clash.statusCode).toBe(409);
      // Keeping its own name is not a clash.
      expect((await cat('PATCH', `/${CATEGORIES.hardware}`, { name: 'Hardware' })).statusCode).toBe(
        200,
      );
      expect(await prisma.ticketCategory.count()).toBe(5);
    });

    it('validates input', async () => {
      for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }]) {
        expect((await cat('POST', '', body)).statusCode).toBe(400);
      }
      expect((await cat('POST', '', { name: 'Ok', isActive: false })).statusCode).toBe(400);
      expect((await cat('PATCH', `/${CATEGORIES.hardware}`, {})).statusCode).toBe(400);
      expect((await cat('PATCH', '/not-a-uuid', { name: 'X' })).statusCode).toBe(400);
      expect((await cat('PATCH', `/${uuid('category', 999)}`, { name: 'X' })).statusCode).toBe(404);
      expect((await cat('POST', `/${uuid('category', 999)}/deactivate`)).statusCode).toBe(404);
      expect(await prisma.ticketCategory.count()).toBe(5);
    });

    it('deactivates and reactivates without touching tickets, and never offers it while inactive', async () => {
      const used = await prisma.ticket.findMany({ where: { categoryId: CATEGORIES.hardware } });
      expect(used.length).toBeGreaterThan(0);

      const off = await cat('POST', `/${CATEGORIES.hardware}/deactivate`);
      expect(off.json().data).toMatchObject({ isActive: false, ticketCount: used.length });
      expect((await cat('POST', `/${CATEGORIES.hardware}/deactivate`)).statusCode).toBe(200); // idempotent
      expect((await staffCategories()).map((c) => c.id)).not.toContain(CATEGORIES.hardware);

      // Existing tickets keep the category and still resolve it.
      const after = await prisma.ticket.findMany({ where: { categoryId: CATEGORIES.hardware } });
      expect(after.map((t) => t.id).sort()).toEqual(used.map((t) => t.id).sort());
      const detail = await call(USERS.erin, 'GET', `/api/tickets/${TICKETS.vpn}`);
      expect(detail.statusCode).toBe(200);
      expect((await cat('GET', `/${CATEGORIES.hardware}`)).json().data.name).toBe('Hardware');

      // New triage cannot use it.
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } });
      const routed = await call(USERS.hana, 'POST', `/api/tickets/${TICKETS.printer}/routing`, {
        categoryId: CATEGORIES.hardware,
        priority: 'HIGH',
        teamId: TEAMS.hardware,
        expectedVersion: ticket.version,
      });
      expect([409, 422]).toContain(routed.statusCode);
      expect(
        (await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } })).version,
      ).toBe(ticket.version);

      const on = await cat('POST', `/${CATEGORIES.hardware}/activate`);
      expect(on.json().data.isActive).toBe(true);
      expect((await staffCategories()).map((c) => c.id)).toContain(CATEGORIES.hardware);
    });

    it('cannot be hard-deleted through the API', async () => {
      expect((await cat('DELETE', `/${CATEGORIES.hardware}`)).statusCode).toBe(404);
      expect(await prisma.ticketCategory.count()).toBe(5);
    });

    it('is ADMIN-only and changes nothing for anyone else', async () => {
      const before = await prisma.ticketCategory.findMany({ orderBy: { id: 'asc' } });
      const attempts: [Method, string, object?][] = [
        ['GET', ''],
        ['POST', '', { name: 'Sneaky' }],
        ['PATCH', `/${CATEGORIES.hardware}`, { name: 'Renamed' }],
        ['POST', `/${CATEGORIES.hardware}/deactivate`],
        ['POST', `/${CATEGORIES.legacy}/activate`],
      ];
      for (const [who, expected] of [
        [null, 401],
        [USERS.erin, 403],
        [USERS.tara, 403],
      ] as const) {
        for (const [method, url, payload] of attempts) {
          expect((await cat(method, url, payload, who)).statusCode).toBe(expected);
        }
      }
      expect(await prisma.ticketCategory.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    });
  });

  describe('teams', () => {
    const team = (method: Method, url: string, payload?: object, as: string | null = USERS.admin) =>
      call(as, method, `/api/admin/teams${url}`, payload);
    const staffTeams = async () =>
      (await call(USERS.hana, 'GET', '/api/teams')).json().data as { id: string }[];

    it('shows how many tickets each team holds and keeps them on deactivation', async () => {
      const list = (await team('GET', '')).json().data as { id: string; ticketCount: number }[];
      for (const t of list) {
        expect(t.ticketCount).toBe(await prisma.ticket.count({ where: { assignedTeamId: t.id } }));
      }
      const held = await prisma.ticket.count({ where: { assignedTeamId: TEAMS.network } });
      expect(held).toBeGreaterThan(0);

      const off = await team('POST', `/${TEAMS.network}/deactivate`);
      expect(off.json().data).toMatchObject({ isActive: false, ticketCount: held });
      expect(await prisma.ticket.count({ where: { assignedTeamId: TEAMS.network } })).toBe(held);
      expect((await staffTeams()).map((t) => t.id)).not.toContain(TEAMS.network);

      const on = await team('POST', `/${TEAMS.network}/activate`);
      expect(on.json().data.isActive).toBe(true);
      expect((await staffTeams()).map((t) => t.id)).toContain(TEAMS.network);
    });

    it('refuses invalid memberships and non-admins', async () => {
      const invalid = [
        { userId: USERS.erin }, // an employee
        { userId: USERS.ingrid }, // an inactive technician
        { userId: uuid('user', 999) }, // unknown
      ];
      const before = await prisma.teamMember.count();
      for (const body of invalid) {
        const res = await team('POST', `/${TEAMS.hardware}/members`, body);
        expect([404, 409]).toContain(res.statusCode);
      }
      expect(
        (await team('POST', `/${TEAMS.hardware}/members`, { userId: USERS.tara }, USERS.tara))
          .statusCode,
      ).toBe(403);
      expect(await prisma.teamMember.count()).toBe(before);
    });
  });
});
