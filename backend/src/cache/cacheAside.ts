import { randomUUID } from 'node:crypto';
import { jitteredBackoff, type CacheClient } from './redisCache.js';

export interface CacheAside {
  /**
   * Serves a cached hit for `keySuffix`, or calls `fetch` on a miss/expiry/malformed entry and
   * best-effort repopulates the cache. Any Redis failure (resolving the version, reading, or
   * writing) falls straight through to `fetch`, so Redis is never load-bearing for correctness:
   * PostgreSQL remains authoritative and is always consulted on any cache problem.
   *
   * Concurrent misses for the same `keySuffix` are deduped: within this process, every caller
   * awaits the same in-flight `fetch`; across processes, one instance holds a short lease (see
   * {@link CacheClient.setIfAbsent}) while the others wait briefly for its result rather than all
   * querying PostgreSQL at once. A holder that crashes self-heals via the lease's own expiry, and
   * a waiter that outlasts the bounded wait falls through to its own direct `fetch` rather than
   * blocking indefinitely -- so a manual ticket action is never stuck behind someone else's fill.
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

/** Bounds how long a crashed lock holder can block a fill before the lease self-heals. */
const LOCK_TTL_MS = 5_000;
/** Bounds how long a waiter polls for another holder's result before falling through to its own
 * direct fetch -- stampede protection must never turn into unbounded blocking. */
const MAX_WAIT_MS = 2_000;

function versionKey(namespace: string): string {
  return `smartdesk:ver:${namespace}`;
}

function lockKey(namespace: string, keySuffix: string): string {
  return `smartdesk:lock:${namespace}:${keySuffix}`;
}

/** Exported for tests that assert on the exact key a value was cached under. */
export function entryKey(namespace: string, version: number, keySuffix: string): string {
  return `smartdesk:${namespace}:v${version}:${keySuffix}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  options: { lockTtlMs?: number; maxWaitMs?: number } = {},
): CacheAside {
  const lockTtlMs = options.lockTtlMs ?? LOCK_TTL_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  // Per-process single-flight: concurrent reads for the same key within this instance share one
  // in-flight fetch instead of each racing for the distributed lock below.
  const inFlight = new Map<string, Promise<unknown>>();

  /** Fills `key` behind a short-lived distributed lease, falling through to a direct, uncached
   * fetch if another holder's result does not show up within the bounded wait. */
  async function fillLocked<T>(
    key: string,
    keySuffix: string,
    fetch: () => Promise<T>,
  ): Promise<T> {
    const lock = lockKey(namespace, keySuffix);
    const token = randomUUID();
    let owner: boolean;
    try {
      owner = await cache.setIfAbsent(lock, token, lockTtlMs);
    } catch {
      owner = false; // Lock itself unavailable: proceed as if contended, below falls through safely.
    }

    if (!owner) {
      const deadline = Date.now() + maxWaitMs;
      for (let attempt = 0; Date.now() < deadline; attempt++) {
        await sleep(Math.min(jitteredBackoff(attempt), Math.max(deadline - Date.now(), 0)));
        try {
          const cached = await cache.get<T>(key);
          if (cached !== undefined) return cached;
        } catch {
          break; // Cache now unavailable too: stop waiting and fetch directly.
        }
      }
      return fetch(); // Bounded wait exhausted: never block a caller indefinitely.
    }

    try {
      const value = await fetch();
      try {
        await cache.set(key, value, ttlSeconds);
      } catch {
        // Best-effort repopulation; a write failure must not affect the value already returned.
      }
      return value;
    } finally {
      try {
        await cache.releaseIfOwner(lock, token);
      } catch {
        // Best-effort release; the lease's own TTL still self-heals if this does not land.
      }
    }
  }

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

      const dedupeKey = `${namespace}:${keySuffix}`;
      const existing = inFlight.get(dedupeKey) as Promise<T> | undefined;
      if (existing) return existing;

      const promise = (key !== undefined ? fillLocked(key, keySuffix, fetch) : fetch()).finally(
        () => inFlight.delete(dedupeKey),
      );
      inFlight.set(dedupeKey, promise);
      return promise;
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
