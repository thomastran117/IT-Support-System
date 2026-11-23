import { describe, expect, it } from 'vitest';
import {
  createFallbackRateLimitStore,
  type RateLimitStoreResult,
} from '../../../src/rateLimit/fallbackStore.js';

interface FakeRedis {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
}

function createFakeRedis(overrides: Partial<FakeRedis> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const counters = new Map<string, number>();
  const redis: FakeRedis = {
    incr: overrides.incr
      ? (key) => {
          calls.push({ method: 'incr', args: [key] });
          return overrides.incr!(key);
        }
      : (key) => {
          calls.push({ method: 'incr', args: [key] });
          const next = (counters.get(key) ?? 0) + 1;
          counters.set(key, next);
          return Promise.resolve(next);
        },
    pexpire: overrides.pexpire
      ? (key, ms) => {
          calls.push({ method: 'pexpire', args: [key, ms] });
          return overrides.pexpire!(key, ms);
        }
      : (key, ms) => {
          calls.push({ method: 'pexpire', args: [key, ms] });
          return Promise.resolve(1);
        },
    pttl: overrides.pttl
      ? (key) => {
          calls.push({ method: 'pttl', args: [key] });
          return overrides.pttl!(key);
        }
      : (key) => {
          calls.push({ method: 'pttl', args: [key] });
          return Promise.resolve(5000);
        },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { redis: redis as any, calls };
}

function incrAsync(
  store: {
    incr(
      key: string,
      cb: (err: Error | null, res?: RateLimitStoreResult) => void,
      timeWindow: number,
    ): void;
  },
  key: string,
  timeWindow: number,
): Promise<RateLimitStoreResult> {
  return new Promise((resolve, reject) => {
    store.incr(key, (err, res) => (err ? reject(err) : resolve(res!)), timeWindow);
  });
}

describe('createFallbackRateLimitStore', () => {
  it('increments via Redis, setting a TTL on the first hit and reading PTTL after', async () => {
    const { redis } = createFakeRedis();
    const Store = createFallbackRateLimitStore(redis, 'ns-');
    const store = new Store();

    await expect(incrAsync(store, 'ip:1', 1000)).resolves.toEqual({ current: 1, ttl: 1000 });
    await expect(incrAsync(store, 'ip:1', 1000)).resolves.toEqual({ current: 2, ttl: 5000 });
  });

  it('prefixes the Redis key with the store namespace', async () => {
    const { redis, calls } = createFakeRedis();
    const Store = createFallbackRateLimitStore(redis, 'ns-');
    const store = new Store();

    await incrAsync(store, 'ip:1', 1000);
    expect(calls[0]).toMatchObject({ method: 'incr', args: ['ns-ip:1'] });
  });

  it('scopes child stores to their own route prefix', async () => {
    const { redis, calls } = createFakeRedis();
    const Store = createFallbackRateLimitStore(redis, 'ns-');
    const parent = new Store();
    const loginStore = parent.child({ routeInfo: { method: 'POST', url: '/login' } });
    const refreshStore = parent.child({ routeInfo: { method: 'POST', url: '/refresh' } });

    await incrAsync(loginStore, 'ip:1', 1000);
    await incrAsync(refreshStore, 'ip:1', 1000);

    const keys = calls.filter((c) => c.method === 'incr').map((c) => c.args[0]);
    expect(keys).toEqual(['ns-POST/login-ip:1', 'ns-POST/refresh-ip:1']);
  });

  it('falls back to a bounded local counter on a Redis failure, rather than skipping', async () => {
    const { redis } = createFakeRedis({ incr: () => Promise.reject(new Error('down')) });
    const Store = createFallbackRateLimitStore(redis, 'ns-');
    const store = new Store();

    await expect(incrAsync(store, 'ip:1', 1000)).resolves.toEqual({ current: 1, ttl: 1000 });
    await expect(incrAsync(store, 'ip:1', 1000)).resolves.toMatchObject({ current: 2 });
    await expect(incrAsync(store, 'ip:1', 1000)).resolves.toMatchObject({ current: 3 });
  });

  it('keeps the local fallback independent per key', async () => {
    const { redis } = createFakeRedis({ incr: () => Promise.reject(new Error('down')) });
    const Store = createFallbackRateLimitStore(redis, 'ns-');
    const store = new Store();

    await expect(incrAsync(store, 'ip:1', 1000)).resolves.toMatchObject({ current: 1 });
    await expect(incrAsync(store, 'ip:2', 1000)).resolves.toMatchObject({ current: 1 });
    await expect(incrAsync(store, 'ip:1', 1000)).resolves.toMatchObject({ current: 2 });
  });
});
