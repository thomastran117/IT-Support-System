import { parseArgs } from 'node:util';
import { createPrisma } from '@smartdesk/db';
import { loadEnv } from '../src/config/env.js';
import { createSearchBulkClient } from '../src/modules/search/bulk.js';
import { SearchSetupError } from '../src/modules/search/initialize.js';
import { searchGeneration } from '../src/modules/search/indexes.js';
import { createSearchRebuild } from '../src/modules/search/rebuild.js';
import { createSearchRebuildAdmin } from '../src/modules/search/rebuildAdmin.js';
import { SearchError } from '../src/modules/search/transport.js';

function parseOptions() {
  try {
    const { values } = parseArgs({
      options: { version: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    });
    const version = Number(values.version);
    if (
      /^[1-9]\d*$/.test(values.version ?? '') &&
      Number.isSafeInteger(version) &&
      version <= 2_147_483_647
    ) {
      return { version, dryRun: values['dry-run'] ?? false };
    }
  } catch {
    // Report a single usage message for invalid options.
  }
  throw new SearchSetupError(
    'Usage: npm run search:reindex -- --version <positive-integer> [--dry-run]',
  );
}

const stop = new AbortController();
const interrupt = () => stop.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
let prisma: ReturnType<typeof createPrisma> | undefined;

try {
  const { version, dryRun } = parseOptions();
  const env = loadEnv();
  const admin = createSearchRebuildAdmin(env.openSearch);
  const bulk = createSearchBulkClient(env.openSearch, { targets: searchGeneration(version) })!;
  prisma = createPrisma(env.databaseUrl);
  const rebuild = createSearchRebuild({ prisma, admin, bulk, version });
  if (dryRun) console.log(JSON.stringify({ dryRun: true, ...(await rebuild.plan()) }));
  else {
    const result = await rebuild.run(stop.signal);
    console.log(
      JSON.stringify({
        version,
        previousVersion: result.sourceVersion,
        watermark: result.replayedThrough.toString(),
        tickets: result.verifiedTickets,
        articles: result.verifiedArticles,
      }),
    );
  }
} catch (error) {
  if (stop.signal.aborted)
    console.error('Search rebuild interrupted. Rerun with the same version to resume.');
  else if (error instanceof SearchError || error instanceof SearchSetupError)
    console.error(error.message);
  else
    console.error(
      'Search rebuild stopped. Check database availability or lock contention, then rerun the same version.',
    );
  process.exitCode = stop.signal.aborted ? 130 : 1;
} finally {
  await prisma?.$disconnect();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
