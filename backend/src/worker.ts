import { createPrisma } from '@smartdesk/db';
import { loadEnv } from './config/env.js';
import { createAnalysisService } from './modules/ai/analysisService.js';
import { createProvider } from './modules/ai/index.js';
import { createJobRunner, type JobLogEntry } from './modules/ai/jobRunner.js';
import { persistDraft } from './modules/ai/recommendationService.js';
import { createEmailDispatcher } from './modules/notifications/email/dispatcher.js';
import { createEmailTransport } from './modules/notifications/email/transport.js';
import { createSearchBulkClient } from './modules/search/bulk.js';
import { createSearchClient } from './modules/search/client.js';
import { createSearchIndexWorker } from './modules/search/indexWorker.js';

/**
 * Background worker for AI, notification email, and search indexing (`npm run start:worker`).
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
  analysis: createAnalysisService({
    prisma,
    provider: createProvider(env),
    searchClient: ai.provider === 'none' ? undefined : createSearchClient(env.openSearch),
  }),
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

// Optional email channel (SD-043). Off by default: with EMAIL_TRANSPORT=none no loop starts and
// nothing is ever sent, and the in-app notification centre works exactly the same.
const { email } = env;
const transport = createEmailTransport(email);
const sendTimeoutMs = 30_000;
const mailer = transport
  ? createEmailDispatcher({
      prisma,
      transport,
      config: {
        appBaseUrl: email.appBaseUrl,
        maxAttempts: email.maxAttempts,
        backoffBaseMs: email.backoffBaseMs,
        maxAgeMs: email.maxAgeMs,
        pollIntervalMs: ai.worker.pollIntervalMs,
        sendTimeoutMs,
        leaseMs: sendTimeoutMs + 30_000,
      },
      log: (entry) => write(entry.errorKind && entry.state !== 'SENT' ? 'error' : 'info', entry),
    })
  : null;

const searchBulk = createSearchBulkClient(env.openSearch);
const searchWorker =
  searchBulk &&
  createSearchIndexWorker({
    prisma,
    bulk: searchBulk,
    pollIntervalMs: ai.worker.pollIntervalMs,
    log: (entry) => write(entry.errorKind ? 'error' : 'info', entry),
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
    await Promise.all([runner.stop(), mailer?.stop(), searchWorker?.stop()]);
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
// Only the transport kind is logged. Host, user and password never are.
write('info', { msg: `email transport: ${email.transport}` });
mailer?.start();
write('info', { msg: `search indexing: ${searchWorker ? 'enabled' : 'disabled'}` });
searchWorker?.start();
