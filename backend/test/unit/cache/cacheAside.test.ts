import { describe, expect, it } from 'vitest';
import { createCacheAside, entryKey } from '../../../src/cache/cacheAside.js';
import { createNoopCache, type CacheClient } from '../../../src/cache/redisCache.js';

interface Entry {
  value: string;
  expiresAt: number | undefined;
}

/** Deterministic in-memory CacheClient for exercising cacheAside's logic without any real
 * socket I/O (a real ioredis connection's background timers can outlive a fast unit test). */
function createFakeCache(): CacheClient {
  const store = new Map<string, Entry>();
  const live = (entry: Entry | undefined): entry is Entry =>
    entry !== undefined && (entry.expiresAt === undefined || entry.expiresAt > Date.now());

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      if (!live(entry)) {
        store.delete(key);
        return undefined;
      }
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
  };
}

describe('createCacheAside', () => {
  it('fetches once on a miss, then serves the cached hit', async () => {
    const aside = createCacheAside(createFakeCache(), 'ref:teams', 60);
    let calls = 0;
    const fetch = async () => {
      calls++;
      return { id: 1 };
    };

    await expect(aside.read('active', fetch)).resolves.toEqual({ id: 1 });
    await expect(aside.read('active', fetch)).resolves.toEqual({ id: 1 });
    expect(calls).toBe(1);
  });

  it('re-fetches once the entry expires', async () => {
    const aside = createCacheAside(createFakeCache(), 'ref:teams', 0.05);
    let calls = 0;
    const fetch = async () => ++calls;

    await expect(aside.read('active', fetch)).resolves.toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(aside.read('active', fetch)).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it('caches different key suffixes independently', async () => {
    const aside = createCacheAside(createFakeCache(), 'ref:teams', 60);
    await expect(aside.read('teams', async () => 'a')).resolves.toBe('a');
    await expect(aside.read('categories', async () => 'b')).resolves.toBe('b');
  });

  it('never serves a stale refill that lands after invalidation (concurrent update/read)', async () => {
    const aside = createCacheAside(createFakeCache(), 'ref:teams', 60);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFetch = async () => {
      await gate; // held open until the invalidation below has already landed
      return 'stale';
    };

    const inFlight = aside.read('active', slowFetch); // resolves the current (pre-bump) generation
    await aside.invalidate(); // bumps the generation while the read above is still fetching
    release();
    await expect(inFlight).resolves.toBe('stale'); // the caller still gets its own fetch's result

    // The next read is on the new generation and must not see that now-orphaned write.
    let calls = 0;
    const fresh = await aside.read('active', async () => {
      calls++;
      return 'fresh';
    });
    expect(fresh).toBe('fresh');
    expect(calls).toBe(1);
  });

  it('is always a miss when disabled (noop cache), and invalidate stays a no-op', async () => {
    const aside = createCacheAside(createNoopCache(), 'ref:teams', 60);
    let calls = 0;
    const fetch = async () => {
      calls++;
      return 'value';
    };

    await aside.read('active', fetch);
    await aside.read('active', fetch);
    expect(calls).toBe(2);
    await expect(aside.invalidate()).resolves.toBeUndefined();
  });

  it('models commit/rollback discipline: only a committed write invalidates the cache', async () => {
    const aside = createCacheAside(createFakeCache(), 'ref:teams', 60);
    let version = 0;
    const fetch = async () => `v${version}`;

    await expect(aside.read('active', fetch)).resolves.toBe('v0');

    // A write that fails before commit must never reach invalidate().
    version = 1;
    try {
      throw new Error('simulated rollback');
    } catch {
      // intentionally does not call aside.invalidate() on this path
    }
    await expect(aside.read('active', fetch)).resolves.toBe('v0'); // untouched by the rollback

    // A write that commits invalidates only once the commit has actually happened.
    version = 2;
    await aside.invalidate();
    await expect(aside.read('active', fetch)).resolves.toBe('v2');
  });

  it('builds keys from the namespace, generation and suffix', () => {
    expect(entryKey('ref:teams', 3, 'active')).toBe('smartdesk:ref:teams:v3:active');
  });

  it('single-flights concurrent misses within one process into a single fetch', async () => {
    const aside = createCacheAside(createFakeCache(), 'ref:teams', 60);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFetch = async () => {
      calls++;
      await gate;
      return 'value';
    };

    const a = aside.read('active', slowFetch);
    const b = aside.read('active', slowFetch);
    release();

    await expect(a).resolves.toBe('value');
    await expect(b).resolves.toBe('value');
    expect(calls).toBe(1);
  });

  it("a waiter serves another holder's result instead of stampeding the fetch itself", async () => {
    const cache = createFakeCache(); // shared, as if both callers hit the same Redis
    const holder = createCacheAside(cache, 'ref:teams', 60, { maxWaitMs: 500 });
    const waiter = createCacheAside(cache, 'ref:teams', 60, { maxWaitMs: 500 });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderCalls = 0;
    const holderFetch = async () => {
      holderCalls++;
      await gate;
      return 'from-holder';
    };
    let waiterCalls = 0;
    const waiterFetch = async () => {
      waiterCalls++;
      return 'from-waiter';
    };

    const holderRead = holder.read('active', holderFetch);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the holder acquire the lock first
    const waiterRead = waiter.read('active', waiterFetch);
    release();

    await expect(holderRead).resolves.toBe('from-holder');
    await expect(waiterRead).resolves.toBe('from-holder'); // served the holder's write, not its own
    expect(holderCalls).toBe(1);
    expect(waiterCalls).toBe(0);
  });

  it('falls through to its own fetch if the lock holder outlasts the bounded wait', async () => {
    const cache = createFakeCache();
    const holder = createCacheAside(cache, 'ref:teams', 60, { maxWaitMs: 100 });
    const waiter = createCacheAside(cache, 'ref:teams', 60, { maxWaitMs: 100 });

    const neverResolves = new Promise<string>(() => {}); // the holder never finishes
    const holderFetch = async () => neverResolves;

    let waiterCalls = 0;
    const waiterFetch = async () => {
      waiterCalls++;
      return 'direct-fetch';
    };

    void holder.read('active', holderFetch); // fire-and-forget: holds the lock indefinitely
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(waiter.read('active', waiterFetch)).resolves.toBe('direct-fetch');
    expect(waiterCalls).toBe(1); // never blocked past its own bounded wait
  });

  it("a crashed holder's lease self-heals: the next caller is not deadlocked", async () => {
    const cache = createFakeCache();
    // Simulate a holder that acquired the lock and then crashed before fetching or releasing.
    await cache.setIfAbsent('smartdesk:lock:ref:teams:active', 'dead-token', 30);

    const aside = createCacheAside(cache, 'ref:teams', 60, { lockTtlMs: 30, maxWaitMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 50)); // outlast the dead lease's TTL

    let calls = 0;
    const fetch = async () => {
      calls++;
      return 'recovered';
    };
    await expect(aside.read('active', fetch)).resolves.toBe('recovered');
    expect(calls).toBe(1);
  });
});
