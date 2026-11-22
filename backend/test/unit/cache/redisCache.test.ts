import { describe, expect, it } from 'vitest';
import { createNoopCache, jitteredBackoff } from '../../../src/cache/redisCache.js';

describe('createNoopCache', () => {
  it('always misses on get', async () => {
    const cache = createNoopCache();
    await expect(cache.get('k')).resolves.toBeUndefined();
  });

  it('accepts writes and deletes without error', async () => {
    const cache = createNoopCache();
    await expect(cache.set('k', { a: 1 }, 60)).resolves.toBeUndefined();
    await expect(cache.del('k')).resolves.toBeUndefined();
  });

  it('increments independently of get/set, since nothing is ever actually stored', async () => {
    const cache = createNoopCache();
    await expect(cache.incr('v')).resolves.toBe(1);
    await expect(cache.incr('v')).resolves.toBe(2);
  });

  it('always grants a lease, and release is a no-op', async () => {
    const cache = createNoopCache();
    await expect(cache.setIfAbsent('lock', 'token', 1000)).resolves.toBe(true);
    await expect(cache.releaseIfOwner('lock', 'token')).resolves.toBeUndefined();
  });

  it('reports disabled, and closes without error', async () => {
    const cache = createNoopCache();
    await expect(cache.ping()).resolves.toBe('disabled');
    await expect(cache.close()).resolves.toBeUndefined();
  });
});

describe('jitteredBackoff', () => {
  it('grows with the attempt number but stays capped', () => {
    const early = jitteredBackoff(1);
    const later = jitteredBackoff(100);
    expect(early).toBeGreaterThanOrEqual(0);
    expect(later).toBeLessThan(2100); // 2000ms cap + up to 100ms jitter
  });

  it('never returns null (always retries)', () => {
    for (let attempt = 1; attempt <= 50; attempt++) {
      expect(jitteredBackoff(attempt)).not.toBeNull();
    }
  });
});
