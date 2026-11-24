import type { Redis } from 'ioredis';

export { createRedisConnection, jitteredBackoff, type RedisConnectionOptions } from './redis.js';

export interface RateLimitStoreResult {
  current: number;
  ttl: number;
}
type RateLimitCallback = (err: Error | null, result?: RateLimitStoreResult) => void;

interface LocalEntry {
  current: number;
  resetAt: number;
}

interface RouteInfo {
  routeInfo: { method: string; url: string };
}

interface RateLimitStore {
  incr(key: string, cb: RateLimitCallback, timeWindow: number): void;
  child(routeOptions: RouteInfo): RateLimitStore;
}

/** Fixed-window INCR against Redis, mirroring @fastify/rate-limit's own Redis store (minus the
 * ban/continueExceeding/exponentialBackoff features this app does not use). Two round trips
 * instead of one Lua call, which is an acceptable tradeoff for a store we fully control. */
async function redisIncr(
  redis: Redis,
  key: string,
  timeWindowMs: number,
): Promise<RateLimitStoreResult> {
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.pexpire(key, timeWindowMs);
    return { current, ttl: timeWindowMs };
  }
  const ttl = await redis.pttl(key);
  return { current, ttl: ttl < 0 ? timeWindowMs : ttl };
}

/**
 * A @fastify/rate-limit store backed by Redis, shared across every backend instance so a quota is
 * enforced once globally rather than once per process. On a Redis failure (timeout, disconnect)
 * it falls back to a bounded per-process, per-route counter instead of the plugin's own
 * `skipOnError` (which lets every request through unlimited) -- a documented, conservative
 * degradation for security-sensitive routes, not a silent bypass. The local fallback is not
 * itself shared across instances, so a genuine multi-instance Redis outage has each instance
 * enforcing its own bound rather than one combined bound; this is the accepted tradeoff.
 *
 * Only `incr` and `child` are implemented. This app's routes never use the plugin's
 * `{ increment: false }` (peek) or `{ refund: true }` (give back a slot) call options, which are
 * the only callers of a store's `read`/`decr` methods.
 */
export function createFallbackRateLimitStore(
  redis: Redis,
  namespace: string,
): new (prefix?: unknown) => RateLimitStore {
  return class FallbackRateLimitStore {
    private readonly prefix: string;
    private readonly local = new Map<string, LocalEntry>();

    /** `prefix` is only ever a real string when called from this class's own `child()` below.
     * The plugin also constructs one top-level instance directly, passing its internal options
     * object (never read here; only `child()`-derived instances ever have `incr` called on
     * them), so this must accept and safely ignore a non-string argument too. */
    constructor(prefix?: unknown) {
      this.prefix = typeof prefix === 'string' ? prefix : namespace;
    }

    incr(key: string, cb: RateLimitCallback, timeWindow: number): void {
      redisIncr(redis, `${this.prefix}${key}`, timeWindow)
        .then((result) => cb(null, result))
        .catch(() => cb(null, this.localIncr(key, timeWindow)));
    }

    private localIncr(key: string, timeWindowMs: number): RateLimitStoreResult {
      const now = Date.now();
      const existing = this.local.get(key);
      if (!existing || existing.resetAt <= now) {
        this.local.set(key, { current: 1, resetAt: now + timeWindowMs });
        return { current: 1, ttl: timeWindowMs };
      }
      existing.current += 1;
      return { current: existing.current, ttl: existing.resetAt - now };
    }

    child(routeOptions: RouteInfo) {
      return new FallbackRateLimitStore(
        `${this.prefix}${routeOptions.routeInfo.method}${routeOptions.routeInfo.url}-`,
      );
    }
  };
}
