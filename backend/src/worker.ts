import { createPrisma } from '@smartdesk/db';
import { loadEnv } from './config/env.js';
import { createAnalysisService } from './modules/ai/analysisService.js';
import { createProvider } from './modules/ai/index.js';
import { createJobRunner, type JobLogEntry } from './modules/ai/jobRunner.js';
import { persistDraft } from './modules/ai/recommendationService.js';

/**
 * Background AI analysis worker: a separate process from the HTTP API (`npm run start:worker`).
 * It claims jobs from the PostgreSQL queue, so work queued while it was down is picked up on start,
 * and several workers can run side by side. It never imports Fastify.
 */
const env = loadEnv();
const prisma = createPrisma(env.databaseUrl);
const { ai } = env;

const write = (level: 'info' | 'error', entry: JobLogEntry) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, ...entry }));

const handlerTimeoutMs = ai.timeoutMs + 10_000;
const runner = createJobRunner({
  prisma,
  analysis: createAnalysisService({ prisma, provider: createProvider(env) }),
  persist: persistDraft,
  config: {
    concurrency: ai.worker.concurrency,
    pollIntervalMs: ai.worker.pollIntervalMs,
    backoffBaseMs: ai.worker.backoffBaseMs,
    handlerTimeoutMs,
    leaseMs: handlerTimeoutMs + 30_000,
  },
  log: (entry) => write(entry.errorKind && entry.state !== 'COMPLETED' ? 'error' : 'info', entry),
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  write('info', { msg: `received ${signal}, draining` });
  // A hard stop after the longest possible analysis, so a hung provider cannot block shutdown;
  // the lease then expires and another worker retries the job.
  const force = setTimeout(() => process.exit(1), handlerTimeoutMs + 5_000);
  force.unref();
  try {
    await runner.stop();
    await prisma.$disconnect();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

write('info', { msg: `ai provider: ${ai.provider}` });
runner.start();
