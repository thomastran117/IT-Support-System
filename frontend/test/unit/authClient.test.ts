import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createApiClient,
  loginErrorMessage,
  NetworkError,
} from '../../src/lib/auth/client';
import { portalFor } from '../../src/lib/auth/roles';

const user = { id: 'u1', email: 'a@x.test', displayName: 'A', role: 'EMPLOYEE' as const };
const session = (token: string) => ({ accessToken: token, expiresIn: 900, user });
const json = (status: number, data: unknown = null, message = 'm') =>
  new Response(JSON.stringify({ message, error: null, details: null, data }), { status });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(handler: Handler) {
  const calls: { url: string; init: RequestInit; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url: String(input), init, auth: headers.get('authorization') });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  const onSessionEnded = vi.fn();
  const client = createApiClient({
    url: (p) => `http://api.test${p}`,
    fetchImpl,
    onSessionEnded,
  });
  return { client, calls, onSessionEnded };
}

describe('api client', () => {
  it('logs in, sends credentials by cookie, then authenticates with the in-memory token', async () => {
    const { client, calls } = setup((url) =>
      url.endsWith('/login') ? json(200, session('t1')) : json(200, user),
    );
    expect((await client.login('a@x.test', 'pw')).user).toEqual(user);
    await client.me();
    expect(calls[0]!.init.credentials).toBe('include');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: 'a@x.test', password: 'pw' });
    expect(calls[0]!.auth).toBeNull();
    expect(calls[1]!.auth).toBe('Bearer t1');
  });

  it('refreshes once on 401 and retries the original request', async () => {
    let token = 'old';
    const { client, calls, onSessionEnded } = setup((url, init) => {
      if (url.endsWith('/refresh')) {
        token = 'new';
        return json(200, session('new'));
      }
      const auth = new Headers(init.headers).get('authorization');
      return auth === `Bearer ${token}` ? json(200, { ok: true }) : json(401);
    });
    await client.restoreSession(); // sets token to 'new'
    token = 'rotated'; // server now expects a different token than the client holds
    expect(await client.request('/api/thing')).toEqual({ ok: true });
    expect(calls.filter((c) => c.url.endsWith('/refresh'))).toHaveLength(2);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('ends the session without looping when refresh is rejected', async () => {
    const { client, calls, onSessionEnded } = setup(() => json(401));
    await expect(client.request('/api/thing')).rejects.toMatchObject({ status: 401 });
    expect(calls.map((c) => c.url.replace('http://api.test', ''))).toEqual([
      '/api/thing',
      '/api/auth/refresh',
    ]);
    expect(onSessionEnded).toHaveBeenCalledOnce();
  });

  it('ends the session when the retried request is still unauthorised', async () => {
    const { client, calls, onSessionEnded } = setup((url) =>
      url.endsWith('/refresh') ? json(200, session('x')) : json(401),
    );
    await expect(client.request('/api/thing')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(3); // request, refresh, one retry; no further attempts
    expect(onSessionEnded).toHaveBeenCalledOnce();
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, calls } = setup(async (url, init) => {
      if (url.endsWith('/refresh')) {
        await gate;
        return json(200, session('fresh'));
      }
      return new Headers(init.headers).get('authorization') === 'Bearer fresh'
        ? json(200, { ok: true })
        : json(401);
    });
    const all = Promise.all([
      client.request('/api/a'),
      client.request('/api/b'),
      client.request('/api/c'),
    ]);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    release();
    await all;
    expect(calls.filter((c) => c.url.endsWith('/refresh'))).toHaveLength(1);
  });

  it('restoreSession returns null (not an error) when there is no valid cookie', async () => {
    const { client } = setup(() => json(401));
    expect(await client.restoreSession()).toBeNull();
  });

  it('surfaces network failures distinctly and does not end the session on them', async () => {
    const { client, onSessionEnded } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.login('a@x.test', 'pw')).rejects.toBeInstanceOf(NetworkError);
    await expect(client.restoreSession()).rejects.toBeInstanceOf(NetworkError);
    await expect(client.request('/api/x')).rejects.toBeInstanceOf(NetworkError);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('logout clears the token even when the server cannot be reached', async () => {
    const { client, calls } = setup((url) => {
      if (url.endsWith('/login')) return json(200, session('t1'));
      throw new TypeError('offline');
    });
    await client.login('a@x.test', 'pw');
    await expect(client.logout()).resolves.toBeUndefined();
    await client.request('/api/x').catch(() => undefined);
    expect(calls.at(-1)!.auth).toBeNull();
  });

  it('never persists the token in browser storage', async () => {
    const storage = { setItem: vi.fn(), getItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const { client } = setup(() => json(200, session('secret-token')));
    await client.login('a@x.test', 'pw');
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('loginErrorMessage', () => {
  it('is generic and non-sensitive', () => {
    expect(loginErrorMessage(new ApiError(401, 'Invalid email or password'))).toBe(
      'Invalid email or password.',
    );
    expect(loginErrorMessage(new ApiError(429, 'x'))).toMatch(/Too many attempts/);
    expect(loginErrorMessage(new NetworkError())).toMatch(/Unable to reach the server/);
    expect(loginErrorMessage(new ApiError(500, 'stack trace here'))).not.toContain('stack');
    expect(loginErrorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
});

describe('portalFor', () => {
  it('maps each role to its own portal', () => {
    expect([portalFor('EMPLOYEE'), portalFor('TECHNICIAN'), portalFor('ADMIN')]).toEqual([
      '/employee',
      '/technician',
      '/admin',
    ]);
  });
});
