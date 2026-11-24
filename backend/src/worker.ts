import { analysisLeaseMs, analysisTimeoutMs } from '@smartdesk/ai-analysis';
import { createPrisma } from '@smartdesk/db';
import { KNOWLEDGE_RETRIEVAL, knowledgeRetrievalSchema } from '@smartdesk/contracts';
import { hashCorrelationId, parseHttpOrigin } from '@smartdesk/service-runtime';
import { createSystemServiceClient } from '@smartdesk/service-runtime/service-tokens';
import { loadEnv } from './config/env.js';
import { createAnalysisService } from './modules/ai/analysisService.js';
import { createProvider } from './modules/ai/index.js';
import { createJobRunner, type JobLogEntry } from './modules/ai/jobRunner.js';
import { persistDraft } from './modules/ai/recommendationService.js';
import { configuredEmailDispatcher } from '@smartdesk/notifications';

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

const remoteKnowledge =
  env.knowledgeExecutionMode === 'service' &&
  env.aiExecutionMode === 'local' &&
  ai.provider !== 'none';
let readKnowledge;
if (remoteKnowledge) {
  const origin = parseHttpOrigin(
    'KNOWLEDGE_RETRIEVAL_ORIGIN',
    process.env.KNOWLEDGE_RETRIEVAL_ORIGIN ?? 'http://localhost:4040',
  );
  if (env.production && origin.protocol !== 'https:') {
    throw new Error('KNOWLEDGE_RETRIEVAL_ORIGIN must use HTTPS in production');
  }
  const kid = process.env.KNOWLEDGE_WORKER_KEY_ID ?? '';
  const privateKey = process.env.KNOWLEDGE_WORKER_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(kid) || !privateKey.trim()) {
    throw new Error('KNOWLEDGE_WORKER_KEY_ID and KNOWLEDGE_WORKER_PRIVATE_KEY are required');
  }
  const call = await createSystemServiceClient({
    origin,
    kid,
    privateKey,
    service: 'ai-local',
    keySetting: 'KNOWLEDGE_WORKER_PRIVATE_KEY',
    route: KNOWLEDGE_RETRIEVAL,
    timeoutMs: 1500,
  });
  readKnowledge = (terms: string[], requestId?: string) =>
    call({ terms }, knowledgeRetrievalSchema.parse, requestId);
}

const write = (
  level: 'info' | 'error',
  entry: JobLogEntry & { event?: 'analysis_job'; analysisCorrelationId?: string },
) =>
  console[level === 'error' ? 'error' : 'log'](
    JSON.stringify({ level, time: Date.now(), service: 'backend-worker', ...entry }),
  );

const handlerTimeoutMs = analysisTimeoutMs(ai);
const runner =
  env.aiExecutionMode === 'local'
    ? createJobRunner({
        prisma,
        analysis: createAnalysisService({
          prisma,
          provider: createProvider(env),
          searchClient: ai.provider === 'none' ? undefined : createSearchClient(env.openSearch),
          readKnowledge,
        }),
        persist: persistDraft,
        config: {
          concurrency: ai.worker.concurrency,
          pollIntervalMs: ai.worker.pollIntervalMs,
          backoffBaseMs: ai.worker.backoffBaseMs,
          handlerTimeoutMs,
          leaseMs: analysisLeaseMs(ai),
        },
        log: ({ requestId, ...entry }) =>
          write(entry.errorKind ? 'error' : 'info', {
            event: 'analysis_job',
            ...entry,
            ...(requestId && { analysisCorrelationId: hashCorrelationId(requestId) }),
          }),
      })
    : null;

// Optional email channel (SD-043). Off by default: with EMAIL_TRANSPORT=none no loop starts and
// nothing is ever sent, and the in-app notification centre works exactly the same.
const { email } = env;
const mailer =
  env.notificationsExecutionMode === 'local'
    ? configuredEmailDispatcher(prisma, email, ai.worker.pollIntervalMs, (entry) =>
        write(entry.errorKind && entry.state !== 'SENT' ? 'error' : 'info', entry),
      )
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
    await Promise.all([runner?.stop(), mailer?.stop(), searchWorker?.stop()]);
    await prisma.$disconnect();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

write('info', { msg: runner ? `ai provider: ${ai.provider}` : 'ai execution: service' });
runner?.start();
// Only the transport kind is logged. Host, user and password never are.
write('info', {
  msg: `email transport: ${env.notificationsExecutionMode === 'service' ? 'service' : email.transport}`,
});
mailer?.start();
write('info', { msg: `search indexing: ${searchWorker ? 'enabled' : 'disabled'}` });
searchWorker?.start();
