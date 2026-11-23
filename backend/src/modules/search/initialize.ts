import { z } from 'zod';
import type { OpenSearchConfig } from '../../config/env.js';
import { searchIndexes, type SearchIndex } from './indexes.js';
import { createSearchTransport, SearchError, type SearchTransport } from './transport.js';

const aliasSchema = z.object({
  is_write_index: z.boolean().optional(),
  filter: z.unknown().optional(),
});
const aliasesResponse = z.record(
  z.string(),
  z.object({ aliases: z.record(z.string(), aliasSchema) }),
);
const publicationFilter = z.strictObject({
  term: z.strictObject({ isPublished: z.literal(true) }),
});
const createResponse = z.object({ acknowledged: z.boolean() });

export class SearchSetupError extends Error {}

async function aliasesReady(request: SearchTransport, index: SearchIndex): Promise<boolean> {
  const indexes = await request({
    path: `_alias/${index.aliasPattern}?expand_wildcards=all`,
    method: 'GET',
    retry: true,
    decode(body) {
      const parsed = aliasesResponse.safeParse(body);
      if (!parsed.success) throw new SearchError('invalid_response');
      return Object.entries(parsed.data);
    },
  });
  const readers = indexes.filter(([, { aliases }]) => aliases[index.readAlias]);
  const writers = indexes.filter(([, { aliases }]) => aliases[index.writeAlias]);
  if (readers.length === 0 && writers.length === 0) return false;

  const reader = readers[0]?.[1].aliases[index.readAlias];
  const writer = writers[0]?.[1].aliases[index.writeAlias];
  const expectedReadFilter =
    'readFilter' in index
      ? publicationFilter.safeParse(reader?.filter).success
      : reader?.filter === undefined;
  if (
    readers.length === 1 &&
    readers[0]?.[0] === index.name &&
    reader?.is_write_index === false &&
    writers.length === 1 &&
    writers[0]?.[0] === index.name &&
    writer?.is_write_index === true &&
    expectedReadFilter
  ) {
    return true;
  }

  throw new SearchSetupError(`Existing OpenSearch aliases for ${index.name} require inspection`);
}

/** First deployment only. Creating an index attaches both aliases in the same cluster operation. */
export async function initializeSearchIndexes(config: OpenSearchConfig): Promise<void> {
  if (!config.enabled)
    throw new SearchSetupError('Set OPENSEARCH_ENABLED=true to initialize search');
  const request = createSearchTransport(config, { timeoutMs: 5_000 });

  for (const index of Object.values(searchIndexes)) {
    if (await aliasesReady(request, index)) continue;
    try {
      await request({
        path: index.name,
        method: 'PUT',
        retry: false,
        body: {
          mappings: index.mappings,
          aliases: {
            [index.readAlias]: {
              is_write_index: false,
              ...('readFilter' in index && { filter: index.readFilter }),
            },
            [index.writeAlias]: { is_write_index: true },
          },
        },
        decode(body) {
          const parsed = createResponse.safeParse(body);
          if (!parsed.success) throw new SearchError('invalid_response');
          if (!parsed.data.acknowledged) throw new SearchError('unavailable');
        },
      });
    } catch (error) {
      // A concurrent initializer or a timed-out response may have committed the creation.
      if (
        error instanceof SearchError &&
        (error.status === 400 || error.retryable) &&
        (await aliasesReady(request, index))
      )
        continue;
      throw error;
    }
  }
}
