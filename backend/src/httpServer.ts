import { buildApp } from './app.js';
import type { Env } from './config/env.js';
import { prismaCheck } from '@smartdesk/db';
import { closeCache, initCache } from './cache/client.js';
import { createRedisConnection } from './cache/redisCache.js';
import { closePrisma, initPrisma } from './db/client.js';
import { createFallbackRateLimitStore } from './rateLimit/fallbackStore.js';

export async function startHttpServer(env: Env): Promise<void> {
  const prisma = initPrisma(env.databaseUrl);
  const cache = initCache(env.redisUrl);
  // A connection of its own, independent of the cache client above: an issue with one must never
  // affect the other's error-handling behaviour (cache fails open, rate limiting does not).
  const rateLimitRedis = env.redisUrl ? createRedisConnection({ url: env.redisUrl }) : undefined;
  const app = await buildApp({
    env,
    prisma,
    checkDb: prismaCheck(prisma),
    checkCache: () => cache.ping(),
    ...(rateLimitRedis
      ? { rateLimitStore: createFallbackRateLimitStore(rateLimitRedis, 'smartdesk-rl-') }
      : {}),
  });

  let closing = false;
  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closePrisma();
      await closeCache();
      rateLimitRedis?.disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.host, port: env.port });
}
