import type { ApiEnvelope, AuthSession, AuthUser, FieldErrors } from '@smartdesk/contracts';

/** Stable classification of every failure the UI has to handle. */
export type ApiErrorKind =
  | 'unauthenticated' // 401, after the single refresh retry
  | 'forbidden' // 403
  | 'not_found' // 404
  | 'conflict' // 409
  | 'validation' // 400/422 with per-field messages
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'network' // never reached the server
  | 'timeout' // no answer in time
  | 'unknown';

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The server answered with an error status. Messages are safe to show to the user. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** Machine-readable domain code (`VERSION_CONFLICT`, ...) from `details.code`, if any. */
  readonly code: string | null;
  /** Per-field messages of a validation failure, keyed by request field. Empty otherwise. */
  readonly fieldErrors: FieldErrors;

  constructor(
    public readonly status: number,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kindForStatus(status);
    this.code = isRecord(details) && typeof details.code === 'string' ? details.code : null;
    this.fieldErrors = {};
    if (this.kind === 'validation' && isRecord(details)) {
      for (const [field, value] of Object.entries(details)) {
        if (Array.isArray(value) && value.every((m) => typeof m === 'string')) {
          this.fieldErrors[field] = value as string[];
        }
      }
    }
  }

  /** A write made against a stale view of the record (409 `VERSION_CONFLICT`). */
  get isVersionConflict(): boolean {
    return this.kind === 'conflict' && this.code === 'VERSION_CONFLICT';
  }
}

/** The request never reached the server (offline, DNS, CORS, server down) or timed out. */
export class NetworkError extends Error {
  readonly kind: 'network' | 'timeout';
  constructor(readonly timedOut = false) {
    super(timedOut ? 'The server took too long to respond' : 'Unable to reach the server');
    this.name = 'NetworkError';
    this.kind = timedOut ? 'timeout' : 'network';
  }
}

/** Classifies any thrown value; non-API failures are `unknown`. */
export function errorKind(err: unknown): ApiErrorKind {
  if (err instanceof ApiError || err instanceof NetworkError) return err.kind;
  return 'unknown';
}

/** Default per-request timeout; a hung connection must not leave a form pending forever. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiClientOptions {
  /** Resolves an API path such as `/api/auth/me` to a full URL. */
  url: (path: string) => string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
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
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await doFetch(options.url(path), { ...init, headers, signal, credentials: 'include' });
    } catch (err) {
      // The caller cancelled (navigated away, superseded search): not a failure to report.
      if (init.signal?.aborted) throw err;
      throw new NetworkError(timeout.aborted);
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
