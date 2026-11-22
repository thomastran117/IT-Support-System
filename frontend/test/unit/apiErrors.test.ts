import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createApiClient,
  errorKind,
  kindForStatus,
  NetworkError,
} from '../../src/lib/auth/client';

const envelope = (status: number, details: unknown = null, message = 'msg') =>
  new Response(JSON.stringify({ message, error: 'E', details, data: null }), { status });

function clientFor(
  handler: (init: RequestInit) => Response | Promise<Response>,
  timeoutMs?: number,
) {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init: RequestInit = {}) =>
    handler(init),
  ) as unknown as typeof fetch;
  return createApiClient({ url: (p) => `http://api.test${p}`, fetchImpl, timeoutMs });
}

describe('stable error shape', () => {
  it.each([
    [400, 'validation'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'validation'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
    [418, 'unknown'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const client = clientFor(() => envelope(status));
    const err = await client.request('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe(kind);
    expect((err as ApiError).status).toBe(status);
    expect(kindForStatus(status)).toBe(kind);
  });

  it('maps an unrecoverable 401 to unauthenticated', async () => {
    const client = clientFor(() => envelope(401));
    const err = (await client.request('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('unauthenticated');
  });

  it('exposes per-field validation messages', async () => {
    const client = clientFor(() =>
      envelope(400, { title: ['Too long'], description: ['Required'] }),
    );
    const err = (await client.request('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.fieldErrors).toEqual({ title: ['Too long'], description: ['Required'] });
    expect(err.code).toBeNull();
  });

  it('ignores details that are not field messages', async () => {
    const err = new ApiError(400, 'bad', { title: 'not-an-array', ok: ['fine'] });
    expect(err.fieldErrors).toEqual({ ok: ['fine'] });
    expect(new ApiError(500, 'x', { title: ['y'] }).fieldErrors).toEqual({});
  });

  it('exposes the domain code and version conflicts', async () => {
    const client = clientFor(() => envelope(409, { code: 'VERSION_CONFLICT' }));
    const err = (await client.request('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.isVersionConflict).toBe(true);
    expect(new ApiError(409, 'x', { code: 'INVALID_TRANSITION' }).isVersionConflict).toBe(false);
  });

  it('survives a non-JSON error body', async () => {
    const client = clientFor(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const err = (await client.request('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('server');
    expect(err.message).toBe('Request failed');
  });

  it('reports a network failure as kind network', async () => {
    const client = clientFor(() => {
      throw new TypeError('Failed to fetch');
    });
    const err = await client.request('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(errorKind(err)).toBe('network');
  });

  it('classifies anything else as unknown', () => {
    expect(errorKind(new Error('boom'))).toBe('unknown');
    expect(errorKind(null)).toBe('unknown');
  });
});

describe('timeouts and cancellation', () => {
  const hang = (init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });

  it('times out a request that never answers', async () => {
    const client = clientFor(hang, 20);
    const err = await client.request('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timedOut).toBe(true);
    expect(errorKind(err)).toBe('timeout');
  });

  it('lets the caller cancel without reporting a failure', async () => {
    const client = clientFor(hang, 5_000);
    const controller = new AbortController();
    const pending = client
      .request('/api/x', { signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(NetworkError);
    expect((err as Error).name).toBe('AbortError');
  });
});
