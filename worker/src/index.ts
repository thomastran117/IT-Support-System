import { createPrisma } from '@smartdesk/db';
import { loadWorkerEnv } from './config.js';

const env = loadWorkerEnv();
const prisma = createPrisma(env.databaseUrl);

let stopping = false;
let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log(JSON.stringify({ level: 'info', msg: 'worker tick', db: 'ok' }));
  } catch (err) {
    console.error(
      JSON.stringify({ level: 'error', msg: 'database unavailable', err: (err as Error).message }),
    );
  }
  if (!stopping) timer = setTimeout(() => void tick(), env.pollIntervalMs);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', msg: 'worker shutting down', signal }));
  if (timer) clearTimeout(timer);
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void tick();
