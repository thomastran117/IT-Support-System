import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { prismaCheck } from '@smartdesk/db';
import { createCacheCheck } from './cache/check.js';
import { closePrisma, initPrisma } from './db/client.js';

const env = loadEnv();
const prisma = initPrisma(env.databaseUrl);
const app = await buildApp({
  env,
  prisma,
  checkDb: prismaCheck(prisma),
  checkCache: createCacheCheck(env.redisUrl),
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closePrisma();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.host, port: env.port });
