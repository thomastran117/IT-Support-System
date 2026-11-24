import { Redis } from 'ioredis';

/** Jittered exponential backoff, capped at 2s. Exported for unit testing in isolation. */
export function jitteredBackoff(attempt: number): number {
  const base = Math.min(attempt * 50, 2000);
  return base + Math.floor(Math.random() * 100);
}

export interface RedisConnectionOptions {
  url: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/** A bounded, jittered-reconnect ioredis connection, shared by the cache client here and by the
 * distributed rate-limit store (backend/src/rateLimit/fallbackStore.ts). Every command is bounded
 * by `commandTimeoutMs` regardless of connection state, so a caller can always fail over within
 * that bound, while a jittered background retry keeps attempting to reconnect. The offline queue
 * stays on so a command issued during the brief startup connection race is not rejected outright;
 * it simply rides the same timeout as a command sent over an already-open connection. */
export function createRedisConnection(opts: RedisConnectionOptions): Redis {
  const redis = new Redis(opts.url, {
    connectTimeout: opts.connectTimeoutMs ?? 1000,
    commandTimeout: opts.commandTimeoutMs ?? 750,
    maxRetriesPerRequest: 1,
    retryStrategy: jitteredBackoff,
  });
  // A rejected command already surfaces the failure to its caller; without a listener here,
  // ioredis's background 'error' events (e.g. a failed reconnect) would be uncaught exceptions.
  redis.on('error', () => {});
  return redis;
}
