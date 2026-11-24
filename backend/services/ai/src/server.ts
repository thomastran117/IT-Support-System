import {
  analyseInputs,
  analysisTimeoutMs,
  createAnalysisRunner,
  createProvider,
} from '@smartdesk/ai-analysis';
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
const runner =
  jobs &&
  createAnalysisRunner({
    config: {
      concurrency: config.ai.worker.concurrency,
      pollIntervalMs: config.ai.worker.pollIntervalMs,
      handlerTimeoutMs: analysisTimeoutMs(config.ai),
    },
    claim: jobs.claim,
    analyse: async (job) => analyseInputs(provider, await jobs.inputs(job)),
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
