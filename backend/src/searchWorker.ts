import { createPrisma } from '@smartdesk/db';
import { parseInteger } from '@smartdesk/service-runtime';
import { loadOpenSearchConfig } from './config/env.js';
import { createSearchBulkClient } from './modules/search/bulk.js';
import { createSearchIndexWorker } from './modules/search/indexWorker.js';
import { loadScopedKnowledgeSources } from './modules/search/loadSearchChanges.js';

const databaseUrl = process.env.SEARCH_DATABASE_URL;
if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
  throw new Error('SEARCH_DATABASE_URL must reference the scoped search login');
}
const bulk = createSearchBulkClient(
  loadOpenSearchConfig(process.env, process.env.NODE_ENV === 'production'),
);
if (!bulk) throw new Error('The search indexer requires OPENSEARCH_ENABLED=true');
const pollIntervalMs = parseInteger(
  'WORKER_POLL_INTERVAL_MS',
  process.env.WORKER_POLL_INTERVAL_MS ?? 5000,
  1,
  60_000,
);
const prisma = createPrisma(databaseUrl);
const worker = createSearchIndexWorker({
  prisma,
  bulk,
  pollIntervalMs,
  loadKnowledgeSources: loadScopedKnowledgeSources,
  log: (entry) => console.log(JSON.stringify(entry)),
});
const stop = () => {
  void worker
    .stop()
    .then(() => prisma.$disconnect())
    .catch(() => {
      console.error('Search indexer shutdown failed');
      process.exitCode = 1;
    });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
worker.start();
