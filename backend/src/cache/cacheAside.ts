import type { CacheClient } from './redisCache.js';

export interface CacheAside {
  /**
   * Serves a cached hit for `keySuffix`, or calls `fetch` on a miss/expiry/malformed entry and
   * best-effort repopulates the cache. Any Redis failure (resolving the version, reading, or
   * writing) falls straight through to `fetch`, so Redis is never load-bearing for correctness:
   * PostgreSQL remains authoritative and is always consulted on any cache problem.
   */
  read<T>(keySuffix: string, fetch: () => Promise<T>): Promise<T>;
  /**
   * Bumps this namespace's generation so every key already cached under it is orphaned rather
   * than overwritten. Call this only after the write that invalidated the data has committed --
   * never from inside the transaction, and never when the write rolled back, so a rollback can
   * never incorrectly invalidate state that was never actually changed.
   */
  invalidate(): Promise<void>;
}

function versionKey(namespace: string): string {
  return `smartdesk:ver:${namespace}`;
}

/** Exported for tests that assert on the exact key a value was cached under. */
export function entryKey(namespace: string, version: number, keySuffix: string): string {
  return `smartdesk:${namespace}:v${version}:${keySuffix}`;
}

/**
 * A cache-aside accessor bound to one namespace (e.g. `"ref:teams"`) and TTL. Keys embed the
 * namespace's current generation, read fresh before each `fetch`. A concurrent `invalidate` that
 * bumps the generation mid-flight orphans this call's eventual write into the now-stale generation
 * segment instead of overwriting the live one -- so a slow stale refill can never clobber data
 * that is already newer, without needing a distributed lock for correctness.
 */
export function createCacheAside(
  cache: CacheClient,
  namespace: string,
  ttlSeconds: number,
): CacheAside {
  return {
    async read<T>(keySuffix: string, fetch: () => Promise<T>): Promise<T> {
      let key: string | undefined;
      try {
        const version = (await cache.get<number>(versionKey(namespace))) ?? 0;
        key = entryKey(namespace, version, keySuffix);
        const cached = await cache.get<T>(key);
        if (cached !== undefined) return cached;
      } catch {
        key = undefined; // Redis unavailable or a malformed entry: fetch is still authoritative.
      }

      const value = await fetch();

      if (key !== undefined) {
        try {
          await cache.set(key, value, ttlSeconds);
        } catch {
          // Best-effort repopulation; a write failure must not affect the value already returned.
        }
      }

      return value;
    },

    async invalidate(): Promise<void> {
      try {
        await cache.incr(versionKey(namespace));
      } catch {
        // Best-effort: a stale entry is still bounded by its own TTL if this does not land.
      }
    },
  };
}
