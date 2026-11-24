import {
  analyseInputs,
  analysisTimeoutMs,
  createAnalysisRunner,
  createProvider,
  retrieveKnowledge,
} from '@smartdesk/ai-analysis';
import { KNOWLEDGE_RETRIEVAL, knowledgeRetrievalSchema } from '@smartdesk/contracts';
import { createSystemServiceClient } from '@smartdesk/service-runtime/service-tokens';
import { buildAiService } from './app.js';
import { loadServiceConfig } from './config.js';
import { classifyTicketJobError, createTicketJobs } from './ticketJobs.js';

const config = loadServiceConfig();
const app = buildAiService(config);
const jobs =
  config.signing &&
  (await createTicketJobs({
    origin: config.ticketOrigin,
    ...config.signing,
    timeoutMs: 5000,
  }));
const provider = createProvider(config.ai);
const lookup =
  config.signing &&
  config.knowledgeOrigin &&
  (await createSystemServiceClient({
    origin: config.knowledgeOrigin,
    ...config.signing,
    service: 'ai',
    keySetting: 'AI_SERVICE_PRIVATE_KEY',
    route: KNOWLEDGE_RETRIEVAL,
    timeoutMs: 1500,
  }));
const runner =
  jobs &&
  createAnalysisRunner({
    config: {
      concurrency: config.ai.worker.concurrency,
      pollIntervalMs: config.ai.worker.pollIntervalMs,
      handlerTimeoutMs: analysisTimeoutMs(config.ai),
    },
    claim: jobs.claim,
    analyse: async (job) => {
      const inputs = await jobs.inputs(job);
      const knowledge =
        lookup &&
        (await retrieveKnowledge(
          (terms, requestId) => lookup({ terms }, knowledgeRetrievalSchema.parse, requestId),
          inputs.ticket,
          job.requestId,
        ));
      return analyseInputs(provider, { ...inputs, ...knowledge });
    },
    complete: jobs.complete,
    fail: jobs.fail,
    classifyError: classifyTicketJobError,
    log: (entry) => app.log[entry.errorKind ? 'warn' : 'info'](entry),
  });
app.addHook('onClose', async () => {
  await runner?.stop();
});
const stop = () => {
  void app.close().catch((err: unknown) => {
    app.log.error({ err }, 'AI service shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.listen({ host: config.host, port: config.port });
runner?.start();
