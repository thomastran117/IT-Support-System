import { Redis } from 'ioredis';
import type { CacheHealthStatus } from '@smartdesk/contracts';

export interface CacheClient {
  /** Parses the stored JSON value, or undefined on a miss. Rejects on a Redis-level failure. */
  get<T>(key: string): Promise<T | undefined>;
  /** Stores `value` as JSON with a TTL. Rejects on a Redis-level failure. */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Lease acquisition: `SET key value PX ttlMs NX`. Resolves false when already held. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Releases a lease only if `token` still matches (CAS), so a lock is never released by a
   * caller that does not hold it. A no-op if the lease already expired or was never held. */
  releaseIfOwner(key: string, token: string): Promise<void>;
  /** Readiness probe: 'disabled' with no backing Redis, otherwise 'ok' or 'unavailable'. */
  ping(): Promise<CacheHealthStatus>;
  /** Graceful shutdown. Safe to call more than once. */
  close(): Promise<void>;
}

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/** Jittered exponential backoff, capped at 2s. Exported for unit testing in isolation. */
export function jitteredBackoff(attempt: number): number {
  const base = Math.min(attempt * 50, 2000);
  return base + Math.floor(Math.random() * 100);
}

export interface RedisCacheOptions {
  url: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/** Backed by a persistent ioredis connection. Every command is bounded by `commandTimeoutMs`
 * regardless of connection state, so a cache-aside caller can always fall back to Postgres within
 * that bound, while a jittered background retry keeps attempting to reconnect. The offline queue
 * stays on so a command issued during the brief startup connection race is not rejected outright;
 * it simply rides the same timeout as a command sent over an already-open connection. */
export function createRedisCache(opts: RedisCacheOptions): CacheClient {
  const redis = new Redis(opts.url, {
    connectTimeout: opts.connectTimeoutMs ?? 1000,
    commandTimeout: opts.commandTimeoutMs ?? 750,
    maxRetriesPerRequest: 1,
    retryStrategy: jitteredBackoff,
  });
  // A rejected command already surfaces the failure to its caller; without a listener here,
  // ioredis's background 'error' events (e.g. a failed reconnect) would be uncaught exceptions.
  redis.on('error', () => {});

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const raw = await redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    },
    async del(key: string): Promise<void> {
      await redis.del(key);
    },
    async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
      const result = await redis.set(key, value, 'PX', ttlMs, 'NX');
      return result === 'OK';
    },
    async releaseIfOwner(key: string, token: string): Promise<void> {
      await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, token);
    },
    async ping(): Promise<CacheHealthStatus> {
      try {
        await redis.ping();
        return 'ok';
      } catch {
        return 'unavailable';
      }
    },
    async close(): Promise<void> {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

/** Disabled mode: every read misses, writes and locks are no-ops that never throw. Callers write
 * against `CacheClient` once and get "no cache" for free, with no scattered `if (redis)` checks. */
export function createNoopCache(): CacheClient {
  return {
    get: async () => undefined,
    set: async () => {},
    del: async () => {},
    setIfAbsent: async () => true,
    releaseIfOwner: async () => {},
    ping: async () => 'disabled',
    close: async () => {},
  };
}
