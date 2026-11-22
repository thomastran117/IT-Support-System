import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedisCache, type CacheClient } from '../../src/cache/redisCache.js';

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('createRedisCache (integration)', () => {
  let cache: CacheClient | undefined;
  afterEach(async () => {
    await cache?.close();
    cache = undefined;
  });

  it('round-trips a value and reports a miss after delete', async () => {
    cache = createRedisCache({ url: redisUrl! });
    const key = `test:cache:${randomUUID()}`;
    await expect(cache.get(key)).resolves.toBeUndefined();

    await cache.set(key, { hello: 'world' }, 60);
    await expect(cache.get(key)).resolves.toEqual({ hello: 'world' });

    await cache.del(key);
    await expect(cache.get(key)).resolves.toBeUndefined();
  });

  it('expires a value once its TTL elapses', async () => {
    cache = createRedisCache({ url: redisUrl! });
    const key = `test:cache:${randomUUID()}`;
    await cache.set(key, 'short-lived', 1);
    await expect(cache.get(key)).resolves.toBe('short-lived');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await expect(cache.get(key)).resolves.toBeUndefined();
  });

  it('grants a lease once, and releases it only for the owning token', async () => {
    cache = createRedisCache({ url: redisUrl! });
    const key = `test:lock:${randomUUID()}`;

    await expect(cache.setIfAbsent(key, 'token-a', 5000)).resolves.toBe(true);
    await expect(cache.setIfAbsent(key, 'token-b', 5000)).resolves.toBe(false);

    // Releasing with the wrong token must not free a lease it does not own.
    await cache.releaseIfOwner(key, 'token-b');
    await expect(cache.setIfAbsent(key, 'token-b', 5000)).resolves.toBe(false);

    await cache.releaseIfOwner(key, 'token-a');
    await expect(cache.setIfAbsent(key, 'token-b', 5000)).resolves.toBe(true);
  });

  it('reports ok and closes gracefully', async () => {
    cache = createRedisCache({ url: redisUrl! });
    await expect(cache.ping()).resolves.toBe('ok');
    await expect(cache.close()).resolves.toBeUndefined();
    cache = undefined;
  });

  it('fails fast within the bounded timeout when Redis is unreachable', async () => {
    const unreachable = createRedisCache({
      url: 'redis://127.0.0.1:1',
      connectTimeoutMs: 300,
      commandTimeoutMs: 300,
    });
    try {
      const start = Date.now();
      await expect(unreachable.get('k')).rejects.toBeDefined();
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      await unreachable.close();
    }
  });
});
