import type { CacheClient } from '../../../src/cache/redisCache.js';

interface Entry {
  value: string;
  expiresAt: number | undefined;
}

export interface CountingCache extends CacheClient {
  /** Successful reads of an actual cached entry (excludes the cache-aside generation lookups). */
  readonly hits: number;
  /** Reads that found no live entry (excludes the cache-aside generation lookups). */
  readonly misses: number;
  /** Clears every entry and zeroes the counters. Call this between tests that share one
   * instance across a describe block's beforeAll, so a prior test's cache state (and hit/miss
   * counts) never leaks into the next -- resetDatabase() alone does not clear this cache. */
  reset(): void;
}

const isGenerationKey = (key: string) => key.startsWith('smartdesk:ver:');

/** Deterministic in-memory CacheClient with hit/miss counters, for asserting an actual
 * measured hit rate without real Redis timing. See backend/test/unit/cache/cacheAside.test.ts
 * for the equivalent fake used to test the cache-aside primitive itself in isolation. */
export function createCountingFakeCache(): CountingCache {
  const store = new Map<string, Entry>();
  const counts = { hits: 0, misses: 0 };
  const live = (entry: Entry | undefined): entry is Entry =>
    entry !== undefined && (entry.expiresAt === undefined || entry.expiresAt > Date.now());

  return {
    get hits() {
      return counts.hits;
    },
    get misses() {
      return counts.misses;
    },
    async get<T>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      const countable = !isGenerationKey(key);
      if (!live(entry)) {
        if (countable) counts.misses++;
        store.delete(key);
        return undefined;
      }
      if (countable) counts.hits++;
      return JSON.parse(entry.value) as T;
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      store.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key: string): Promise<void> {
      store.delete(key);
    },
    async incr(key: string): Promise<number> {
      const entry = store.get(key);
      const current = live(entry) ? (JSON.parse(entry.value) as number) : 0;
      const next = current + 1;
      store.set(key, { value: JSON.stringify(next), expiresAt: undefined });
      return next;
    },
    async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
      if (live(store.get(key))) return false;
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async releaseIfOwner(key: string, token: string): Promise<void> {
      const entry = store.get(key);
      if (live(entry) && entry.value === token) store.delete(key);
    },
    ping: async () => 'ok',
    close: async () => {},
    reset(): void {
      store.clear();
      counts.hits = 0;
      counts.misses = 0;
    },
  };
}
