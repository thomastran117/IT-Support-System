import { loadEnv } from '../src/config/env.js';
import { initializeSearchIndexes, SearchSetupError } from '../src/modules/search/initialize.js';
import { SearchError } from '../src/modules/search/transport.js';

try {
  await initializeSearchIndexes(loadEnv().openSearch);
  console.log('OpenSearch v1 indexes and aliases are ready');
} catch (error) {
  console.error(
    error instanceof SearchError || error instanceof SearchSetupError
      ? error.message
      : 'Search initialization failed. Check the server environment settings.',
  );
  process.exitCode = 1;
}
