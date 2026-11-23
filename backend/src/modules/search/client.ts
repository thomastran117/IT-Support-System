import { z } from 'zod';
import type { OpenSearchConfig } from '../../config/env.js';
import { liveSearchFilters, searchIndexes, type SearchCollection } from './indexes.js';
import { createSearchTransport, SearchError, type SearchTransportOptions } from './transport.js';

const sortValue = z.union([z.string(), z.number(), z.null()]);
const searchResponse = z.object({
  timed_out: z.boolean(),
  hits: z.object({
    hits: z.array(
      z.object({
        _id: z.string(),
        sort: z.array(sortValue).optional(),
        fields: z.object({ version: z.unknown().optional() }).optional(),
      }),
    ),
  }),
});
const revisionField = z.tuple([z.int().positive()]);

export interface SearchRequest {
  query: Record<string, unknown>;
  size: number;
  sort?: readonly Record<string, 'asc' | 'desc'>[];
  searchAfter?: readonly z.infer<typeof sortValue>[];
  includeRevision?: boolean;
}

export interface SearchCandidate {
  id: string;
  sort?: z.infer<typeof sortValue>[];
  revision?: number;
}

export interface SearchClient {
  search(collection: SearchCollection, request: SearchRequest): Promise<SearchCandidate[]>;
}

/** The caller must hydrate and authorize candidate IDs against PostgreSQL. */
export function createSearchClient(
  config: OpenSearchConfig,
  options?: SearchTransportOptions,
): SearchClient | undefined {
  if (!config.enabled) return undefined;
  const request = createSearchTransport(config, options);

  return {
    async search(collection, { query, size, sort, searchAfter, includeRevision }) {
      if (!Number.isInteger(size) || size < 1 || size > 100) {
        throw new RangeError('OpenSearch candidate page size must be between 1 and 100');
      }
      return request({
        path: `${searchIndexes[collection].readAlias}/_search?allow_partial_search_results=false`,
        method: 'POST',
        retry: true,
        body: {
          // Live ticket projections have status. A removal keeps only its identity and revision.
          query:
            collection === 'tickets'
              ? { bool: { must: [query], filter: [liveSearchFilters.tickets] } }
              : query,
          size,
          sort,
          search_after: searchAfter,
          ...(includeRevision && { docvalue_fields: ['version'] }),
          _source: false,
          track_total_hits: false,
        },
        decode(body) {
          const parsed = searchResponse.safeParse(body);
          if (!parsed.success) throw new SearchError('invalid_response');
          if (parsed.data.timed_out) throw new SearchError('timeout');
          return parsed.data.hits.hits.map(({ _id, sort, fields }) => {
            const revision = includeRevision ? revisionField.safeParse(fields?.version) : undefined;
            return {
              id: _id,
              ...(sort && { sort }),
              ...(revision?.success && { revision: revision.data[0] }),
            };
          });
        },
      });
    },
  };
}
