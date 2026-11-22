import { Redis } from 'ioredis';
import type { CacheHealthStatus } from '@smartdesk/contracts';

export type CacheCheck = () => Promise<CacheHealthStatus>;

/**
 * One-shot readiness probe only: connects, pings, disconnects per call, with no
 * retry/reconnect. Superseded by the shared cache client in SD-068, which will
 * replace this file once it lands.
 */
export function createCacheCheck(redisUrl: string | undefined): CacheCheck {
  if (!redisUrl) return async () => 'disabled';
  return async () => {
    const client = new Redis(redisUrl, {
      connectTimeout: 500,
      commandTimeout: 500,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    // ioredis emits 'error' even for failures already surfaced via the rejected
    // promise below; without a listener, Node treats that as an uncaught exception.
    client.on('error', () => {});
    try {
      await client.connect();
      await client.ping();
      return 'ok';
    } catch {
      return 'unavailable';
    } finally {
      client.disconnect();
    }
  };
}
