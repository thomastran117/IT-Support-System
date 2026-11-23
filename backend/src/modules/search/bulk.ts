import { z } from 'zod';
import type { OpenSearchConfig } from '../../config/env.js';
import type { SearchIndexErrorKind } from '../../db/repositories/searchIndexJobs.js';
import { searchIndexes, type SearchCollection } from './indexes.js';
import {
  createSearchTransport,
  isTransientSearchStatus,
  SearchError,
  type SearchTransportOptions,
} from './transport.js';

export interface SearchIndexWrite {
  collection: SearchCollection;
  id: string;
  externalVersion: number;
  document: object;
}

export type SearchIndexFailure = { ok: false; kind: SearchIndexErrorKind; retryable: boolean };
export type SearchIndexResult = { ok: true } | SearchIndexFailure;

export interface SearchBulkClient {
  write(writes: readonly SearchIndexWrite[]): Promise<SearchIndexResult[]>;
}

const indexedItem = z.object({
  _id: z.string(),
  status: z.int(),
  error: z.object({ type: z.string() }).optional(),
});
const bulkResponse = z.object({ items: z.array(z.object({ index: indexedItem })) });

function statusFailure(status: number): SearchIndexFailure {
  if (status === 408) return { ok: false, kind: 'timeout', retryable: true };
  if (status === 429) return { ok: false, kind: 'rate_limited', retryable: true };
  if (status === 404) return { ok: false, kind: 'index_missing', retryable: true };
  if (status === 401 || status === 403)
    return { ok: false, kind: 'authorization', retryable: false };
  if (isTransientSearchStatus(status)) return { ok: false, kind: 'unavailable', retryable: true };
  return { ok: false, kind: 'rejected', retryable: false };
}

export function bulkFailure(error: unknown): SearchIndexFailure {
  if (!(error instanceof SearchError)) return { ok: false, kind: 'unavailable', retryable: true };
  if (error.status !== undefined) return statusFailure(error.status);
  if (error.code === 'http_error') return { ok: false, kind: 'rejected', retryable: false };
  return { ok: false, kind: error.code, retryable: true };
}

export function createSearchBulkClient(
  config: OpenSearchConfig,
  {
    targets,
    ...options
  }: SearchTransportOptions & { targets?: Record<SearchCollection, string> } = {},
): SearchBulkClient | undefined {
  if (!config.enabled) return undefined;
  const request = createSearchTransport(config, { timeoutMs: 5_000, ...options });

  return {
    async write(writes) {
      if (writes.length === 0) return [];
      const lines = writes.flatMap(({ collection, id, externalVersion, document }) => [
        JSON.stringify({
          index: {
            _index: targets?.[collection] ?? searchIndexes[collection].writeAlias,
            _id: id,
            version: externalVersion,
            version_type: 'external',
          },
        }),
        JSON.stringify(document),
      ]);
      return request({
        path: targets ? '_bulk' : '_bulk?require_alias=true',
        method: 'POST',
        body: `${lines.join('\n')}\n`,
        contentType: 'application/x-ndjson',
        retry: false,
        decode(body) {
          const parsed = bulkResponse.safeParse(body);
          if (!parsed.success || parsed.data.items.length !== writes.length) {
            throw new SearchError('invalid_response');
          }
          return parsed.data.items.map(({ index }, i): SearchIndexResult => {
            if (index._id !== writes[i]?.id) throw new SearchError('invalid_response');
            if (index.status >= 200 && index.status < 300) return { ok: true };
            // Strict external versions make an equal (replayed) or newer write a successful no-op.
            if (index.status === 409 && index.error?.type === 'version_conflict_engine_exception') {
              return { ok: true };
            }
            return statusFailure(index.status);
          });
        },
      });
    },
  };
}
