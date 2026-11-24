import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { TokenService } from '../../../src/auth/tokens.js';
import { loadEnv } from '../../../src/config/env.js';

const base = loadEnv({});
const svc = new TokenService(base);
const key = (s: string) => new TextEncoder().encode(s);

describe('TokenService', () => {
  it('round-trips access and refresh tokens', async () => {
    const access = await svc.sign('access', 'u1', 3);
    expect(await svc.verify('access', access)).toEqual({ sub: 'u1', tv: 3, kind: 'access' });
    const refresh = await svc.sign('refresh', 'u1', 3);
    expect(await svc.verify('refresh', refresh)).toMatchObject({ sub: 'u1', kind: 'refresh' });
  });

  it('does not accept one kind of token as the other', async () => {
    expect(await svc.verify('refresh', await svc.sign('access', 'u1', 0))).toBeNull();
    expect(await svc.verify('access', await svc.sign('refresh', 'u1', 0))).toBeNull();
  });

  it('rejects expired, tampered, foreign and unsigned tokens', async () => {
    const expired = await new TokenService({ ...base, accessTtlSeconds: -60 }).sign(
      'access',
      'u1',
      0,
    );
    expect(await svc.verify('access', expired)).toBeNull();

    const good = await svc.sign('access', 'u1', 0);
    const [h, p, s] = good.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'admin' }),
    ).toString('base64url');
    expect(await svc.verify('access', `${h}.${forgedPayload}.${s}`)).toBeNull();

    const otherSecret = new TokenService({ ...base, jwtSecret: 'x'.repeat(40) });
    expect(await svc.verify('access', await otherSecret.sign('access', 'u1', 0))).toBeNull();
    const otherAud = new TokenService({ ...base, jwtAudience: 'someone-else' });
    expect(await svc.verify('access', await otherAud.sign('access', 'u1', 0))).toBeNull();
    const otherIss = new TokenService({ ...base, jwtIssuer: 'someone-else' });
    expect(await svc.verify('access', await otherIss.sign('access', 'u1', 0))).toBeNull();

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`;
    expect(await svc.verify('access', none)).toBeNull();
    expect(await svc.verify('access', 'garbage')).toBeNull();
    expect(await svc.verify('access', '')).toBeNull();
  });

  it('rejects a token signed with another algorithm family member', async () => {
    const hs512 = await new SignJWT({ tv: 0, kind: 'access' })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('u1')
      .setIssuer(base.jwtIssuer)
      .setAudience(base.jwtAudience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key(base.jwtSecret));
    expect(await svc.verify('access', hs512)).toBeNull();
  });
});

describe('loadEnv auth settings', () => {
  it('uses a development secret outside production', () => {
    expect(loadEnv({}).jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(loadEnv({}).cookieSecure).toBe(false);
    expect(loadEnv({}).accessTtlSeconds).toBe(900);
  });

  it('refuses a missing, short or placeholder secret in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() =>
      loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'change-me-dev-only-change-me-dev-only' }),
    ).toThrow(/JWT_SECRET/);
    const env = loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'r'.repeat(48) });
    expect(env.cookieSecure).toBe(true);
  });

  it('rejects non-positive lifetimes', () => {
    expect(() => loadEnv({ ACCESS_TOKEN_TTL_SECONDS: '0' })).toThrow(/ACCESS_TOKEN_TTL_SECONDS/);
  });

  it('configures Ticket without a browser signing key in Identity service mode', () => {
    const settings = {
      NODE_ENV: 'production',
      IDENTITY_EXECUTION_MODE: 'service',
      IDENTITY_SERVICE_ORIGIN: 'https://identity.internal.test',
      TICKET_IDENTITY_KEY_ID: 'ticket',
      TICKET_IDENTITY_PRIVATE_KEY: 'loaded by the Ticket signer',
      TICKET_SEARCH_CURSOR_SECRET: 'c'.repeat(40),
    };
    const env = loadEnv(settings);
    expect(env.jwtSecret).toBe('');
    expect(env.ticketSearchCursorSecret).toBe(settings.TICKET_SEARCH_CURSOR_SECRET);
    expect(env.identity?.identityOrigin.protocol).toBe('https:');
    expect(() => loadEnv({ ...settings, TICKET_SEARCH_CURSOR_SECRET: '' })).toThrow(
      /TICKET_SEARCH_CURSOR_SECRET/,
    );
    expect(() =>
      loadEnv({ ...settings, IDENTITY_SERVICE_ORIGIN: 'http://identity.internal.test' }),
    ).toThrow(/IDENTITY_SERVICE_ORIGIN/);
  });
});
