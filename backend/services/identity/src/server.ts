import { createPrisma } from '@smartdesk/db';
import {
  createFallbackRateLimitStore,
  createRedisConnection,
} from '@smartdesk/identity/rate-limit';
import { buildIdentityApp } from './app.js';
import { loadServiceConfig } from './config.js';

const config = loadServiceConfig();
const prisma = createPrisma(config.databaseUrl);
const redis = config.redisUrl ? createRedisConnection({ url: config.redisUrl }) : undefined;
const app = await buildIdentityApp({
  ...config,
  prisma,
  rateLimitStore: redis && createFallbackRateLimitStore(redis, 'smartdesk-rl-'),
});
app.addHook('onClose', async () => {
  redis?.disconnect();
  await prisma.$disconnect();
});
const stop = () => {
  void app.close().catch(() => {
    app.log.error('Identity shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.listen({ host: config.host, port: config.port });
