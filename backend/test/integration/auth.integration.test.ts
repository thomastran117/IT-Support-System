import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { DEMO_PASSWORD, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const ORIGIN = 'http://app.test';
const env = loadEnv({ FRONTEND_ORIGIN: ORIGIN });
const tokens = new TokenService(env);

describe.skipIf(!testDatabaseUrl)('auth endpoints (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const build = async (extra: Partial<AppOptions> = {}) => {
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
      logger: false,
      // Generous by default so ordinary tests never trip the limiter.
      authRateLimit: { login: 1000, refresh: 1000, windowMs: 60_000 },
      ...extra,
    });
    return app;
  };

  const login = (email: string, password: string = DEMO_PASSWORD) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
    res.cookies.find((c) => c.name === 'sd_refresh');
  const refresh = (token: string | undefined, origin: string | null = ORIGIN) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: origin ? { origin } : {},
      cookies: token ? { sd_refresh: token } : {},
    });
  const me = (token?: string) =>
    app.inject({
      url: '/api/auth/me',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  // Tests that mutate users restore them here.
  beforeEach(() =>
    prisma.user.updateMany({
      data: { tokenVersion: 0 },
    }),
  );
  afterEach(async () => {
    await app?.close();
    await prisma.user.updateMany({ data: { isActive: true } });
    await prisma.user.updateMany({
      where: { id: { in: [USERS.ivan, USERS.ingrid] } },
      data: { isActive: false },
    });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  describe('POST /login', () => {
    it.each([
      ['employee', 'erin@smartdesk.test', 'EMPLOYEE'],
      ['technician', 'tara@smartdesk.test', 'TECHNICIAN'],
      ['admin', 'admin@smartdesk.test', 'ADMIN'],
    ])('signs in the seeded %s', async (_n, email, role) => {
      await build();
      const res = await login(email);
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.user).toMatchObject({ email, role });
      expect(data.expiresIn).toBe(env.accessTtlSeconds);
      expect(await tokens.verify('access', data.accessToken)).toMatchObject({ kind: 'access' });
      expect(res.headers['cache-control']).toBe('no-store');
      // Never leaks credentials or the revocation counter.
      expect(JSON.stringify(res.json())).not.toMatch(
        /passwordHash|password_hash|tokenVersion|argon2/,
      );
    });

    it('normalises the email (case and whitespace)', async () => {
      await build();
      expect((await login('  ERIN@SmartDesk.test ')).statusCode).toBe(200);
    });

    it('sets a hardened refresh cookie', async () => {
      await build();
      const res = await login('erin@smartdesk.test');
      const set = String(res.headers['set-cookie']);
      expect(set).toMatch(/^sd_refresh=/);
      expect(set).toMatch(/HttpOnly/i);
      expect(set).toMatch(/SameSite=Strict/i);
      expect(set).toMatch(/Path=\/api\/auth/);
      expect(set).toMatch(new RegExp(`Max-Age=${env.refreshTtlSeconds}`));
      expect(set).not.toMatch(/Secure/i); // dev config
      expect(await tokens.verify('refresh', cookieOf(res)!.value)).toMatchObject({
        sub: USERS.erin,
      });
      // The refresh token is not in the body.
      expect(res.body).not.toContain(cookieOf(res)!.value);
    });

    it('marks the cookie Secure when configured (production)', async () => {
      const secureEnv = loadEnv({
        FRONTEND_ORIGIN: ORIGIN,
        NODE_ENV: 'production',
        JWT_SECRET: 'r'.repeat(48),
      });
      await build({ env: secureEnv });
      expect(String((await login('erin@smartdesk.test')).headers['set-cookie'])).toMatch(/Secure/i);
    });

    it('gives the same generic answer for wrong password, unknown, inactive and credential-less users', async () => {
      await build();
      await prisma.user.update({ where: { id: USERS.omar }, data: { passwordHash: null } });
      const attempts = await Promise.all([
        login('erin@smartdesk.test', 'wrong-password'),
        login('nobody@smartdesk.test'),
        login('ivan.inactive@smartdesk.test'), // correct password, inactive account
        login('omar@smartdesk.test'), // no credential
      ]);
      const first = attempts[0]!;
      for (const res of attempts) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual(first.json());
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      expect(first.json().message).toBe('Invalid email or password');
      await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! }); // refills hash
    });

    it.each([
      [{}],
      [{ email: 'erin@smartdesk.test' }],
      [{ email: '', password: 'x' }],
      [{ email: 42, password: 'x' }],
      [{ email: 'erin@smartdesk.test', password: 'x'.repeat(2000) }],
    ])('rejects malformed input %j with 400', async (payload) => {
      await build();
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /me', () => {
    it('returns the profile for a valid access token', async () => {
      await build();
      const token = (await login('tara@smartdesk.test')).json().data.accessToken;
      const res = await me(token);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        id: USERS.tara,
        email: 'tara@smartdesk.test',
        displayName: 'Tara Technician',
        role: 'TECHNICIAN',
      });
    });

    it('rejects anonymous, malformed, wrong-scheme and wrong-kind tokens', async () => {
      await build();
      const refreshTok = await tokens.sign('refresh', USERS.erin, 0);
      const expired = await new TokenService({ ...env, accessTtlSeconds: -60 }).sign(
        'access',
        USERS.erin,
        0,
      );
      expect((await me()).statusCode).toBe(401);
      expect((await me('garbage')).statusCode).toBe(401);
      expect((await me(refreshTok)).statusCode).toBe(401); // refresh token is not an access token
      expect((await me(expired)).statusCode).toBe(401);
      const basic = await app.inject({
        url: '/api/auth/me',
        headers: { authorization: 'Basic abc' },
      });
      expect(basic.statusCode).toBe(401);
    });

    it('stops honouring a token once token_version moves or the user is disabled', async () => {
      await build();
      const token = (await login('erin@smartdesk.test')).json().data.accessToken;
      expect((await me(token)).statusCode).toBe(200);
      await prisma.user.update({
        where: { id: USERS.erin },
        data: { tokenVersion: { increment: 1 } },
      });
      expect((await me(token)).statusCode).toBe(401);

      const fresh = (await login('omar@smartdesk.test')).json().data.accessToken;
      await prisma.user.update({ where: { id: USERS.omar }, data: { isActive: false } });
      expect((await me(fresh)).statusCode).toBe(401);
    });

    it('reflects a role change immediately instead of trusting the token', async () => {
      await build();
      const token = (await login('omar@smartdesk.test')).json().data.accessToken;
      await prisma.user.update({ where: { id: USERS.omar }, data: { role: 'TECHNICIAN' } });
      expect((await me(token)).json().data.role).toBe('TECHNICIAN');
      await prisma.user.update({ where: { id: USERS.omar }, data: { role: 'EMPLOYEE' } });
    });
  });

  describe('POST /refresh', () => {
    it('mints a new access token and re-issues the cookie', async () => {
      await build();
      const first = await login('erin@smartdesk.test');
      const res = await refresh(cookieOf(first)!.value);
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect((await me(data.accessToken)).statusCode).toBe(200);
      expect(data.user.email).toBe('erin@smartdesk.test');
      expect(cookieOf(res)).toBeDefined();
      expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
    });

    it('rejects missing, malformed, wrong-kind, expired and tampered tokens', async () => {
      await build();
      const expired = await new TokenService({ ...env, refreshTtlSeconds: -60 }).sign(
        'refresh',
        USERS.erin,
        0,
      );
      const access = await tokens.sign('access', USERS.erin, 0);
      const good = await tokens.sign('refresh', USERS.erin, 0);
      const tampered = good.slice(0, -3) + (good.endsWith('AAA') ? 'BBB' : 'AAA');
      for (const t of [undefined, 'garbage', access, expired, tampered]) {
        const res = await refresh(t);
        expect(res.statusCode, String(t).slice(0, 20)).toBe(401);
        expect(res.json().data).toBeNull();
        expect(res.json()).not.toHaveProperty('data.accessToken');
      }
    });

    it('is refused after the user is disabled or token_version is bumped', async () => {
      await build();
      const erin = cookieOf(await login('erin@smartdesk.test'))!.value;
      await prisma.user.update({
        where: { id: USERS.erin },
        data: { tokenVersion: { increment: 1 } },
      });
      expect((await refresh(erin)).statusCode).toBe(401);

      const omar = cookieOf(await login('omar@smartdesk.test'))!.value;
      await prisma.user.update({ where: { id: USERS.omar }, data: { isActive: false } });
      expect((await refresh(omar)).statusCode).toBe(401);
    });

    it('rejects a missing or foreign Origin (CSRF) even with a valid cookie', async () => {
      await build();
      const token = cookieOf(await login('erin@smartdesk.test'))!.value;
      expect((await refresh(token, null)).statusCode).toBe(403);
      expect((await refresh(token, 'http://evil.test')).statusCode).toBe(403);
    });

    it('lets concurrent refreshes all succeed (stateless: no rotation to race)', async () => {
      await build();
      const token = cookieOf(await login('erin@smartdesk.test'))!.value;
      const results = await Promise.all(Array.from({ length: 8 }, () => refresh(token)));
      expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    });
  });

  describe('POST /logout', () => {
    it('clears the refresh cookie and is idempotent', async () => {
      await build();
      const token = cookieOf(await login('erin@smartdesk.test'))!.value;
      for (let i = 0; i < 2; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { origin: ORIGIN },
          cookies: { sd_refresh: token },
        });
        expect(res.statusCode).toBe(200);
        const cleared = cookieOf(res)!;
        expect(cleared.value).toBe('');
        expect(String(res.headers['set-cookie'])).toMatch(/Path=\/api\/auth/);
        expect(String(res.headers['set-cookie'])).toMatch(/Expires=Thu, 01 Jan 1970/);
      }
      // The browser no longer sends the cookie, so refreshing fails.
      expect((await refresh(undefined)).statusCode).toBe(401);
    });

    it('enforces the Origin check', async () => {
      await build();
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('abuse controls', () => {
    it('rate-limits login attempts per client', async () => {
      await build({ authRateLimit: { login: 3, refresh: 3, windowMs: 60_000 } });
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push((await login('erin@smartdesk.test', 'bad')).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      const limited = await login('erin@smartdesk.test');
      expect(limited.json()).toMatchObject({ error: 'Too Many Requests', data: null });
    });

    it('rate-limits refresh', async () => {
      await build({ authRateLimit: { login: 100, refresh: 2, windowMs: 60_000 } });
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await refresh('garbage')).statusCode);
      expect(codes).toEqual([401, 401, 429]);
    });

    it('never writes passwords, tokens or cookies to the logs', async () => {
      const lines: string[] = [];
      const stream = new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      });
      await build({
        logger: {
          level: 'trace',
          stream,
        },
      });
      const ok = await login('erin@smartdesk.test');
      const access: string = ok.json().data.accessToken;
      const cookie = cookieOf(ok)!.value;
      await login('erin@smartdesk.test', 'a-wrong-secret-password');
      await me(access);
      await refresh(cookie);
      const logs = lines.join('\n');
      expect(logs.length).toBeGreaterThan(0);
      for (const secret of [DEMO_PASSWORD, 'a-wrong-secret-password', access, cookie]) {
        expect(logs).not.toContain(secret);
      }
    });
  });
});
