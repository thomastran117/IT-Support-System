import type { OpenSearchConfig } from '../../config/env.js';

type SearchErrorCode =
  'timeout' | 'unavailable' | 'circuit_open' | 'http_error' | 'invalid_response';

export class SearchError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    readonly status?: number,
  ) {
    super(`OpenSearch ${code}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'SearchError';
  }

  get retryable(): boolean {
    return this.code === 'timeout' || this.code === 'unavailable';
  }
}

export interface SearchTransportOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

interface Operation<T> {
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  body?: object | string;
  contentType?: 'application/x-ndjson';
  retry: boolean;
  decode: (body: unknown) => T;
}

export type SearchTransport = <T>(operation: Operation<T>) => Promise<T>;

type Circuit =
  { state: 'closed'; failures: number } | { state: 'open'; retryAt: number } | { state: 'probing' };

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
export const isTransientSearchStatus = (status: number) => RETRYABLE_STATUS.has(status);
const FAILURES_TO_OPEN = 3;
const COOLDOWN_MS = 10_000;

export function createSearchTransport(
  config: Extract<OpenSearchConfig, { enabled: true }>,
  { fetch: send = fetch, timeoutMs = 750, now = Date.now }: SearchTransportOptions = {},
): SearchTransport {
  const endpoint = new URL(config.url);
  if (!endpoint.pathname.endsWith('/')) endpoint.pathname += '/';
  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
  if (config.auth) {
    const basic = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64');
    headers.set('authorization', `Basic ${basic}`);
  }

  let circuit: Circuit = { state: 'closed', failures: 0 };

  async function attempt<T>({ path, method, body, contentType, decode }: Operation<T>): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    const target = new URL(path, endpoint);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const requestHeaders = contentType ? new Headers(headers) : headers;
    if (contentType) requestHeaders.set('content-type', contentType);
    let response: Response;
    try {
      response = await send(target, {
        method,
        body: payload,
        headers: requestHeaders,
        signal,
        redirect: 'manual',
      });
    } catch {
      throw new SearchError(signal.aborted ? 'timeout' : 'unavailable');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new SearchError(
        isTransientSearchStatus(response.status) ? 'unavailable' : 'http_error',
        response.status,
      );
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new SearchError(signal.aborted ? 'timeout' : 'invalid_response');
    }
    return decode(result);
  }

  return async (operation) => {
    if (circuit.state === 'probing') throw new SearchError('circuit_open');
    if (circuit.state === 'open') {
      if (now() < circuit.retryAt) throw new SearchError('circuit_open');
      circuit = { state: 'probing' };
    }
    const started = circuit;
    const reset = () => {
      if (circuit !== started) return;
      if (started.state === 'closed') started.failures = 0;
      else circuit = { state: 'closed', failures: 0 };
    };

    try {
      const result = await attempt(operation).catch((error: unknown) => {
        // A probe performs one attempt. Reads may retry once during normal operation.
        if (
          circuit === started &&
          started.state === 'closed' &&
          operation.retry &&
          error instanceof SearchError &&
          error.retryable
        ) {
          return attempt(operation);
        }
        throw error;
      });
      reset();
      return result;
    } catch (error) {
      if (circuit === started) {
        if (!(error instanceof SearchError) || !error.retryable) reset();
        else if (started.state === 'probing' || ++started.failures >= FAILURES_TO_OPEN) {
          circuit = { state: 'open', retryAt: now() + COOLDOWN_MS };
        }
      }
      throw error;
    }
  };
}
