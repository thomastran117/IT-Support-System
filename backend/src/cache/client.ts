import type { CacheHealthStatus } from '@smartdesk/contracts';
import { createNoopCache, createRedisCache, type CacheClient } from './redisCache.js';

export type CacheCheck = () => Promise<CacheHealthStatus>;

/**
 * Process-wide cache client. One connection per process (API or worker), created at startup and
 * closed on shutdown. Never create a client per request.
 */
let instance: CacheClient | undefined;

/** Create the client once. Calling again returns the existing instance. An undefined `redisUrl`
 * (Redis disabled) yields a no-op implementation of the same interface. */
export function initCache(redisUrl: string | undefined): CacheClient {
  instance ??= redisUrl ? createRedisCache({ url: redisUrl }) : createNoopCache();
  return instance;
}

export function getCache(): CacheClient {
  if (!instance) throw new Error('Cache client is not initialised; call initCache() first');
  return instance;
}

/** Graceful shutdown. Safe to call more than once. */
export async function closeCache(): Promise<void> {
  const client = instance;
  instance = undefined;
  if (client) await client.close();
}
