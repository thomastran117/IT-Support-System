import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPool, poolCheck } from './db/pool.js';

const env = loadEnv();
const pool = createPool(env.databaseUrl);
const app = await buildApp({ env, checkDb: poolCheck(pool) });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.host, port: env.port });
