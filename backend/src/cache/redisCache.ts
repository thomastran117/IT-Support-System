import { createRedisConnection, type RedisConnectionOptions } from '@smartdesk/identity/rate-limit';
export {
  createRedisConnection,
  jitteredBackoff,
  type RedisConnectionOptions,
} from '@smartdesk/identity/rate-limit';
import type { CacheHealthStatus } from '@smartdesk/contracts';

export interface CacheClient {
  /** Parses the stored JSON value, or undefined on a miss. Rejects on a Redis-level failure. */
  get<T>(key: string): Promise<T | undefined>;
  /** Stores `value` as JSON with a TTL. Rejects on a Redis-level failure. */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic increment, starting from 0 if the key is absent. Used as a namespace generation
   * counter for cache-aside invalidation (see cacheAside.ts), not as a general counter. */
  incr(key: string): Promise<number>;
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

export type RedisCacheOptions = RedisConnectionOptions;

/** See {@link createRedisConnection} for the connection's lifecycle and timeout behavior. */
export function createRedisCache(opts: RedisCacheOptions): CacheClient {
  const redis = createRedisConnection(opts);

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
    async incr(key: string): Promise<number> {
      return redis.incr(key);
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
  let counter = 0;
  return {
    get: async () => undefined,
    set: async () => {},
    del: async () => {},
    incr: async () => ++counter,
    setIfAbsent: async () => true,
    releaseIfOwner: async () => {},
    ping: async () => 'disabled',
    close: async () => {},
  };
}
