import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { TICKETS, USERS, DEMO_PASSWORD } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createUserService } from '../../src/modules/admin/userService.js';
import {
  createTestPrisma,
  expectViolation,
  insertRow,
  resetDatabase,
  testDatabaseUrl,
} from './helpers/db.js';

const ORIGIN = 'http://app.test';
const env = loadEnv({ FRONTEND_ORIGIN: ORIGIN });
const tokens = new TokenService(env);
const API = '/api/admin';

describe.skipIf(!testDatabaseUrl)('admin user provisioning (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;
  let admin2: string;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (
    as: string | null,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `${API}${url}`,
      headers: as ? await bearer(as) : {},
      payload,
    });
  const login = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const audit = (targetId?: string) =>
    prisma.adminAuditLog.findMany({
      where: targetId ? { targetUserId: targetId } : {},
      orderBy: { createdAt: 'asc' },
    });
  const newUser = (over: Record<string, unknown> = {}) => ({
    email: 'new.person@smartdesk.test',
    displayName: 'New Person',
    role: 'EMPLOYEE',
    ...over,
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
    const second = await insertRow(prisma, 'users', {
      email: 'second.admin@smartdesk.test',
      display_name: 'Second Admin',
      role: 'ADMIN',
    });
    admin2 = second.user_id as string;
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  describe('authorization', () => {
    const target = USERS.omar;
    const endpoints = [
      ['GET', '/users'],
      ['POST', '/users'],
      ['PATCH', `/users/${target}/role`],
      ['POST', `/users/${target}/deactivate`],
      ['POST', `/users/${target}/activate`],
      ['POST', `/users/${target}/reset-password`],
      ['GET', '/audit-log'],
    ] as const;

    it.each(endpoints)('anonymous %s %s is 401', async (method, url) => {
      expect((await call(null, method, url, {})).statusCode).toBe(401);
    });

    it.each(endpoints)(
      'employee and technician %s %s are 403 and change nothing',
      async (method, url) => {
        for (const who of [USERS.erin, USERS.tara]) {
          expect((await call(who, method, url, newUser({ role: 'ADMIN' }))).statusCode).toBe(403);
        }
        expect(await audit()).toHaveLength(0);
        expect(await prisma.user.count()).toBe(9);
      },
    );

    it('a technician cannot promote themselves or create an admin', async () => {
      const res = await call(USERS.tara, 'PATCH', `/users/${USERS.tara}/role`, { role: 'ADMIN' });
      expect(res.statusCode).toBe(403);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: USERS.tara } })).role).toBe(
        'TECHNICIAN',
      );
    });

    it('allows the CORS preflight for PATCH from the frontend origin', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: `${API}/users/${target}/role`,
        headers: {
          origin: ORIGIN,
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(String(res.headers['access-control-allow-methods'])).toContain('PATCH');
    });
  });

  describe('create', () => {
    it('creates a user with a one-time password that works, stored only as an Argon2id hash', async () => {
      const res = await call(
        USERS.admin,
        'POST',
        '/users',
        newUser({ email: '  New.Person@SmartDesk.test ' }),
      );
      expect(res.statusCode).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { user, temporaryPassword } = res.json().data;
      expect(user).toMatchObject({
        email: 'new.person@smartdesk.test',
        displayName: 'New Person',
        role: 'EMPLOYEE',
        isActive: true,
      });
      expect(temporaryPassword.length).toBeGreaterThanOrEqual(20);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordHash).not.toContain(temporaryPassword);

      const signedIn = await login('new.person@smartdesk.test', temporaryPassword);
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json().data.user.role).toBe('EMPLOYEE');
    });

    it('never returns private fields', async () => {
      const res = await call(USERS.admin, 'POST', '/users', newUser());
      const text = res.body;
      expect(text).not.toMatch(/passwordHash|password_hash|tokenVersion|token_version|argon2/i);
      expect(Object.keys(res.json().data.user).sort()).toEqual(
        ['createdAt', 'displayName', 'email', 'id', 'isActive', 'role'].sort(),
      );
    });

    it('rejects a duplicate email regardless of case', async () => {
      expect((await call(USERS.admin, 'POST', '/users', newUser())).statusCode).toBe(201);
      for (const email of [
        'new.person@smartdesk.test',
        'NEW.Person@SMARTDESK.test',
        'erin@smartdesk.test',
      ]) {
        const res = await call(USERS.admin, 'POST', '/users', newUser({ email }));
        expect(res.statusCode, email).toBe(409);
      }
      expect(await prisma.user.count()).toBe(10);
    });

    it.each([
      ['unknown role', { role: 'SUPERUSER' }],
      ['lowercase role', { role: 'admin' }],
      ['bad email', { email: 'not-an-email' }],
      ['blank name', { displayName: '   ' }],
      ['missing role', { role: undefined }],
      ['unexpected field (no mass assignment)', { isActive: false, passwordHash: 'x' }],
      ['oversized name', { displayName: 'x'.repeat(121) }],
    ])('rejects %s with 400 and creates nothing', async (_n, over) => {
      const res = await call(USERS.admin, 'POST', '/users', newUser(over));
      expect(res.statusCode).toBe(400);
      expect(await prisma.user.count()).toBe(9);
      expect(await audit()).toHaveLength(0);
    });

    it('records who created whom in the audit trail', async () => {
      const { user } = (
        await call(USERS.admin, 'POST', '/users', newUser({ role: 'TECHNICIAN' }))
      ).json().data;
      const [entry] = await audit(user.id);
      expect(entry).toMatchObject({
        actorId: USERS.admin,
        action: 'USER_CREATED',
        details: { role: 'TECHNICIAN' },
      });
    });
  });

  describe('list', () => {
    it('lists, filters and paginates without private fields', async () => {
      const all = (await call(USERS.admin, 'GET', '/users')).json().data;
      expect(all.total).toBe(9);
      expect(all.items.map((u: { email: string }) => u.email)).toEqual(
        [...all.items.map((u: { email: string }) => u.email)].sort(),
      );
      expect(JSON.stringify(all)).not.toMatch(/passwordHash|tokenVersion|argon2/i);

      const techs = (await call(USERS.admin, 'GET', '/users?role=TECHNICIAN')).json().data;
      expect(techs.items.every((u: { role: string }) => u.role === 'TECHNICIAN')).toBe(true);
      expect(techs.total).toBe(4);

      const inactive = (await call(USERS.admin, 'GET', '/users?active=false')).json().data;
      expect(inactive.items.map((u: { email: string }) => u.email).sort()).toEqual([
        'ingrid.inactive@smartdesk.test',
        'ivan.inactive@smartdesk.test',
      ]);

      const search = (await call(USERS.admin, 'GET', '/users?q=TARA')).json().data;
      expect(search.items.map((u: { email: string }) => u.email)).toEqual(['tara@smartdesk.test']);

      const page = (await call(USERS.admin, 'GET', '/users?limit=3&offset=3')).json().data;
      expect(page.items).toHaveLength(3);
      expect(page.total).toBe(9);
    });

    it('rejects bad query values', async () => {
      for (const q of ['role=ROOT', 'limit=0', 'limit=1000', 'offset=-1', 'active=maybe']) {
        expect((await call(USERS.admin, 'GET', `/users?${q}`)).statusCode, q).toBe(400);
      }
    });
  });

  describe('role changes', () => {
    it('changes the role, signs the user out everywhere and audits it', async () => {
      const oldHeaders = await bearer(USERS.omar);
      const res = await call(USERS.admin, 'PATCH', `/users/${USERS.omar}/role`, {
        role: 'TECHNICIAN',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: USERS.omar, role: 'TECHNICIAN' });
      // Old tokens (issued with the previous token_version) no longer work.
      const me = await app.inject({ url: '/api/auth/me', headers: oldHeaders });
      expect(me.statusCode).toBe(401);
      // A fresh sign-in carries the new role.
      const again = await login('omar@smartdesk.test', DEMO_PASSWORD);
      expect(again.json().data.user.role).toBe('TECHNICIAN');
      const [entry] = await audit(USERS.omar);
      expect(entry).toMatchObject({
        action: 'ROLE_CHANGED',
        details: { from: 'EMPLOYEE', to: 'TECHNICIAN' },
      });
    });

    it('refuses self-escalation and self-demotion', async () => {
      for (const role of ['ADMIN', 'EMPLOYEE']) {
        const res = await call(USERS.admin, 'PATCH', `/users/${USERS.admin}/role`, { role });
        expect(res.statusCode).toBe(403);
      }
      expect(await audit()).toHaveLength(0);
    });

    it('is a no-op (no audit entry, tokens stay valid) when the role is unchanged', async () => {
      const headers = await bearer(USERS.omar);
      const res = await call(USERS.admin, 'PATCH', `/users/${USERS.omar}/role`, {
        role: 'EMPLOYEE',
      });
      expect(res.statusCode).toBe(200);
      expect(await audit()).toHaveLength(0);
      expect((await app.inject({ url: '/api/auth/me', headers })).statusCode).toBe(200);
    });

    it('lets one admin demote another while another remains', async () => {
      const res = await call(USERS.admin, 'PATCH', `/users/${admin2}/role`, { role: 'EMPLOYEE' });
      expect(res.statusCode).toBe(200);
    });

    it('rejects invalid roles, unknown users and malformed ids', async () => {
      expect(
        (await call(USERS.admin, 'PATCH', `/users/${USERS.omar}/role`, { role: 'ROOT' }))
          .statusCode,
      ).toBe(400);
      expect((await call(USERS.admin, 'PATCH', `/users/${USERS.omar}/role`, {})).statusCode).toBe(
        400,
      );
      expect(
        (await call(USERS.admin, 'PATCH', '/users/not-a-uuid/role', { role: 'ADMIN' })).statusCode,
      ).toBe(400);
      const missing = '00000000-0000-4000-8000-0000000000ff';
      expect(
        (await call(USERS.admin, 'PATCH', `/users/${missing}/role`, { role: 'ADMIN' })).statusCode,
      ).toBe(404);
    });
  });

  describe('last active administrator guard', () => {
    const service = () => createUserService(prisma);

    it('refuses to deactivate or demote the only active admin (service level)', async () => {
      await prisma.user.update({ where: { id: admin2 }, data: { isActive: false } });
      // The actor here is deliberately not an admin: only the guard itself is under test.
      await expect(service().setActive(USERS.erin, USERS.admin, false)).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(service().setRole(USERS.erin, USERS.admin, 'EMPLOYEE')).rejects.toMatchObject({
        statusCode: 409,
      });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: USERS.admin } })).isActive).toBe(
        true,
      );
    });

    it('does not count inactive admins as remaining administrators', async () => {
      await prisma.user.update({ where: { id: admin2 }, data: { isActive: false } });
      await expect(service().setRole(USERS.erin, USERS.admin, 'TECHNICIAN')).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it('two admins removing each other at once cannot leave the system without an admin', async () => {
      for (let round = 0; round < 5; round++) {
        await prisma.user.updateMany({
          where: { id: { in: [USERS.admin, admin2] } },
          data: { isActive: true, role: 'ADMIN', tokenVersion: 0 },
        });
        const [a, b] = await Promise.all([
          call(USERS.admin, 'POST', `/users/${admin2}/deactivate`),
          call(admin2, 'POST', `/users/${USERS.admin}/deactivate`),
        ]);
        const codes = [a.statusCode, b.statusCode].sort();
        // One wins. The loser is refused by the guard (409), or by authentication (401) if the
        // winner had already committed before the loser's token was checked.
        expect(codes[0]).toBe(200);
        expect([401, 409]).toContain(codes[1]);
        const active = await prisma.user.count({ where: { role: 'ADMIN', isActive: true } });
        expect(active).toBeGreaterThanOrEqual(1);
      }
    });

    it('demoting via role change races the same way', async () => {
      const [a, b] = await Promise.all([
        call(USERS.admin, 'PATCH', `/users/${admin2}/role`, { role: 'EMPLOYEE' }),
        call(admin2, 'PATCH', `/users/${USERS.admin}/role`, { role: 'EMPLOYEE' }),
      ]);
      expect([a.statusCode, b.statusCode].sort()[0]).toBe(200);
      expect(
        await prisma.user.count({ where: { role: 'ADMIN', isActive: true } }),
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe('deactivation and activation', () => {
    it('blocks login, refresh and existing tokens immediately', async () => {
      const signedIn = await login('erin@smartdesk.test', DEMO_PASSWORD);
      const refreshCookie = signedIn.cookies.find((c) => c.name === 'sd_refresh')!.value;
      const accessToken: string = signedIn.json().data.accessToken;

      const res = await call(USERS.admin, 'POST', `/users/${USERS.erin}/deactivate`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.isActive).toBe(false);

      expect((await login('erin@smartdesk.test', DEMO_PASSWORD)).statusCode).toBe(401);
      const refresh = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { origin: ORIGIN },
        cookies: { sd_refresh: refreshCookie },
      });
      expect(refresh.statusCode).toBe(401);
      const me = await app.inject({
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(me.statusCode).toBe(401);
    });

    it('keeps historical tickets, requester and technician references intact', async () => {
      const before = await prisma.ticket.findMany({ orderBy: { id: 'asc' } });
      await call(USERS.admin, 'POST', `/users/${USERS.erin}/deactivate`); // requester of several tickets
      await call(USERS.admin, 'POST', `/users/${USERS.tom}/deactivate`); // assignee of the license ticket
      const after = await prisma.ticket.findMany({ orderBy: { id: 'asc' } });
      expect(after).toEqual(before);
      const license = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.license } });
      expect(license.assigneeId).toBe(USERS.tom);
      expect(await prisma.ticketEvent.count({ where: { actorId: USERS.tom } })).toBeGreaterThan(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: USERS.tom } })).isActive).toBe(
        false,
      );
    });

    it('reactivation lets the user sign in again, and only admins can do it', async () => {
      await call(USERS.admin, 'POST', `/users/${USERS.erin}/deactivate`);
      expect((await call(USERS.omar, 'POST', `/users/${USERS.erin}/activate`)).statusCode).toBe(
        403,
      );
      expect((await call(USERS.tara, 'POST', `/users/${USERS.erin}/activate`)).statusCode).toBe(
        403,
      );
      expect((await login('erin@smartdesk.test', DEMO_PASSWORD)).statusCode).toBe(401);

      expect((await call(USERS.admin, 'POST', `/users/${USERS.erin}/activate`)).statusCode).toBe(
        200,
      );
      expect((await login('erin@smartdesk.test', DEMO_PASSWORD)).statusCode).toBe(200);
      expect((await audit(USERS.erin)).map((e) => e.action)).toEqual([
        'USER_DEACTIVATED',
        'USER_ACTIVATED',
      ]);
    });

    it('refuses self-deactivation and is idempotent otherwise', async () => {
      expect((await call(USERS.admin, 'POST', `/users/${USERS.admin}/deactivate`)).statusCode).toBe(
        403,
      );
      await call(USERS.admin, 'POST', `/users/${USERS.erin}/deactivate`);
      const again = await call(USERS.admin, 'POST', `/users/${USERS.erin}/deactivate`);
      expect(again.statusCode).toBe(200);
      expect(await audit(USERS.erin)).toHaveLength(1);
    });

    it('returns 404 for unknown users', async () => {
      const missing = '00000000-0000-4000-8000-0000000000ff';
      expect((await call(USERS.admin, 'POST', `/users/${missing}/deactivate`)).statusCode).toBe(
        404,
      );
    });
  });

  describe('password reset (rotation)', () => {
    it('issues a new one-time password, retires the old one and revokes tokens', async () => {
      const old = await bearer(USERS.erin);
      const res = await call(USERS.admin, 'POST', `/users/${USERS.erin}/reset-password`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { temporaryPassword, user } = res.json().data;
      expect(JSON.stringify(user)).not.toMatch(/passwordHash|tokenVersion/);

      expect((await login('erin@smartdesk.test', DEMO_PASSWORD)).statusCode).toBe(401);
      expect((await login('erin@smartdesk.test', temporaryPassword)).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/auth/me', headers: old })).statusCode).toBe(401);

      const [entry] = await audit(USERS.erin);
      expect(entry!.action).toBe('PASSWORD_RESET');
      expect(JSON.stringify(entry)).not.toContain(temporaryPassword);
    });

    it('cannot reset your own password, and non-admins cannot reset anyone', async () => {
      expect(
        (await call(USERS.admin, 'POST', `/users/${USERS.admin}/reset-password`)).statusCode,
      ).toBe(403);
      expect(
        (await call(USERS.erin, 'POST', `/users/${USERS.omar}/reset-password`)).statusCode,
      ).toBe(403);
    });

    it('lets a deactivated user be reset without activating them', async () => {
      const res = await call(USERS.admin, 'POST', `/users/${USERS.ivan}/reset-password`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.user.isActive).toBe(false);
      expect(
        (await login('ivan.inactive@smartdesk.test', res.json().data.temporaryPassword)).statusCode,
      ).toBe(401);
    });
  });

  describe('audit trail', () => {
    it('lists entries newest first with who and whom, and no secrets', async () => {
      const created = (await call(USERS.admin, 'POST', '/users', newUser())).json().data;
      await call(USERS.admin, 'PATCH', `/users/${USERS.omar}/role`, { role: 'TECHNICIAN' });
      await call(USERS.admin, 'POST', `/users/${USERS.erin}/reset-password`);

      const res = await call(USERS.admin, 'GET', '/audit-log');
      expect(res.statusCode).toBe(200);
      const entries = res.json().data;
      expect(entries.map((e: { action: string }) => e.action)).toEqual([
        'PASSWORD_RESET',
        'ROLE_CHANGED',
        'USER_CREATED',
      ]);
      expect(entries[0]).toMatchObject({
        actor: { email: 'admin@smartdesk.test' },
        target: { email: 'erin@smartdesk.test' },
      });
      expect(res.body).not.toContain(created.temporaryPassword);
      expect(res.body).not.toMatch(/passwordHash|argon2|tokenVersion/i);
    });

    it('is append-only: rows cannot be edited or deleted, even by SQL', async () => {
      await call(USERS.admin, 'POST', '/users', newUser());
      await expectViolation(
        prisma.$executeRaw`UPDATE admin_audit_log SET action = 'ROLE_CHANGED'`,
        'append-only',
      );
      await expectViolation(prisma.$executeRaw`DELETE FROM admin_audit_log`, 'append-only');
      expect(await audit()).toHaveLength(1);
    });

    it('only accepts known actions and object details', async () => {
      const base = { actor_id: USERS.admin, target_user_id: USERS.erin };
      await expectViolation(
        insertRow(prisma, 'admin_audit_log', { ...base, action: 'NUKE' }),
        'ck_admin_audit_action',
      );
      await expectViolation(
        insertRow(prisma, 'admin_audit_log', { ...base, action: 'USER_CREATED', details: '[]' }),
        'ck_admin_audit_details_object',
      );
    });

    it('is rolled back together with a failed change (no orphan entry)', async () => {
      await call(USERS.admin, 'POST', '/users', newUser());
      const dup = await call(USERS.admin, 'POST', '/users', newUser());
      expect(dup.statusCode).toBe(409);
      expect(await audit()).toHaveLength(1);
    });
  });
});
