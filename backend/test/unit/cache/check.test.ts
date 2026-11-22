import { describe, expect, it } from 'vitest';
import { createCacheCheck } from '../../../src/cache/check.js';

describe('createCacheCheck', () => {
  it('reports disabled when no REDIS_URL is configured', async () => {
    const check = createCacheCheck(undefined);
    await expect(check()).resolves.toBe('disabled');
  });

  it('reports unavailable within the bounded timeout when Redis is unreachable', async () => {
    const check = createCacheCheck('redis://127.0.0.1:1');
    const start = Date.now();
    await expect(check()).resolves.toBe('unavailable');
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
