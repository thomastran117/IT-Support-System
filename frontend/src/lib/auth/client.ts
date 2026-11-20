import type { ApiEnvelope, AuthSession, AuthUser } from '@smartdesk/contracts';

/** The server answered with an error status. Messages are safe to show to the user. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never reached the server (offline, DNS, CORS, server down). */
export class NetworkError extends Error {
  constructor() {
    super('Unable to reach the server');
    this.name = 'NetworkError';
  }
}

export interface ApiClientOptions {
  /** Resolves an API path such as `/api/auth/me` to a full URL. */
  url: (path: string) => string;
  fetchImpl?: typeof fetch;
  /** Called when the session can no longer be restored (refresh rejected). */
  onSessionEnded?: () => void;
}

export interface ApiClient {
  login(email: string, password: string): Promise<AuthSession>;
  /** Try to restore a session from the refresh cookie. null when there is none. */
  restoreSession(): Promise<AuthSession | null>;
  logout(): Promise<void>;
  /** Authenticated request: attaches the token and, on 401, refreshes once and retries once. */
  request<T>(path: string, init?: RequestInit): Promise<T>;
  me(): Promise<AuthUser>;
}

const AUTH = '/api/auth';

/**
 * Browser API client. The access token lives only in this closure (memory): it is never written
 * to localStorage, sessionStorage, cookies or URLs, and is lost on reload, after which
 * {@link ApiClient.restoreSession} gets a new one from the HttpOnly refresh cookie.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetchImpl ?? ((...args) => fetch(...args));
  let accessToken: string | null = null;
  let refreshing: Promise<AuthSession | null> | null = null;

  async function send(path: string, init: RequestInit = {}, token?: string | null) {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    if (token) headers.set('authorization', `Bearer ${token}`);
    try {
      return await doFetch(options.url(path), { ...init, headers, credentials: 'include' });
    } catch {
      throw new NetworkError();
    }
  }

  async function readEnvelope<T>(res: Response): Promise<ApiEnvelope<T> | null> {
    try {
      return (await res.json()) as ApiEnvelope<T>;
    } catch {
      return null;
    }
  }

  async function fail(res: Response): Promise<never> {
    const body = await readEnvelope<unknown>(res);
    throw new ApiError(res.status, body?.message ?? 'Request failed', body?.details ?? null);
  }

  /** One refresh at a time: concurrent callers share the same in-flight request. */
  function restoreSession(): Promise<AuthSession | null> {
    refreshing ??= (async () => {
      try {
        const res = await send(`${AUTH}/refresh`, { method: 'POST' });
        if (res.status === 401 || res.status === 403) {
          accessToken = null;
          return null;
        }
        if (!res.ok) return await fail(res);
        const session = (await readEnvelope<AuthSession>(res))?.data;
        if (!session) throw new ApiError(res.status, 'Unexpected response');
        accessToken = session.accessToken;
        return session;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res = await send(path, init, accessToken);
    if (res.status === 401) {
      // Exactly one refresh and one retry, so a rejected session can never loop.
      const session = await restoreSession();
      if (session) res = await send(path, init, accessToken);
      if (!session || res.status === 401) {
        accessToken = null;
        options.onSessionEnded?.();
        throw new ApiError(401, 'Your session has ended. Please sign in again.');
      }
    }
    if (!res.ok) return fail(res);
    return (await readEnvelope<T>(res))?.data as T;
  }

  return {
    async login(email, password) {
      const res = await send(`${AUTH}/login`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) return fail(res);
      const session = (await readEnvelope<AuthSession>(res))?.data;
      if (!session) throw new ApiError(res.status, 'Unexpected response');
      accessToken = session.accessToken;
      return session;
    },
    restoreSession,
    async logout() {
      accessToken = null;
      try {
        await send(`${AUTH}/logout`, { method: 'POST' });
      } catch {
        // Local state is already cleared; the cookie expires on its own.
      }
    },
    request,
    me: () => request<AuthUser>(`${AUTH}/me`),
  };
}

/** Maps a failed sign-in to a message that reveals nothing about which accounts exist. */
export function loginErrorMessage(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'Unable to reach the server. Check your connection and try again.';
  }
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Invalid email or password.';
    if (err.status === 429) return 'Too many attempts. Please wait a minute and try again.';
    if (err.status === 400) return 'Enter a valid email address and password.';
  }
  return 'Something went wrong. Please try again.';
}
