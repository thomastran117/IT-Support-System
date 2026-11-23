import { z } from 'zod';
import type { OpenSearchConfig } from '../../config/env.js';
import {
  acknowledgeIndexChange,
  aliasProperties,
  readIndexAliasTarget,
  SearchSetupError,
} from './initialize.js';
import {
  liveSearchFilters,
  searchCollections,
  searchGeneration,
  searchIndexes,
  type SearchCollection,
} from './indexes.js';
import { createSearchTransport, SearchError, type SearchTransportOptions } from './transport.js';

const metadataResponse = z.record(
  z.string(),
  z.object({
    mappings: z.object({
      dynamic: z.string().optional(),
      _meta: z.object({ smartdesk_rebuild_id: z.string().optional() }).optional(),
    }),
  }),
);
const shards = z.object({ _shards: z.object({ failed: z.int() }) });
const countResponse = shards.extend({ count: z.int().nonnegative() });

export function createSearchRebuildAdmin(
  config: OpenSearchConfig,
  options?: SearchTransportOptions,
) {
  if (!config.enabled)
    throw new SearchSetupError('Set OPENSEARCH_ENABLED=true to access the rebuild target');
  const request = createSearchTransport(config, { timeoutMs: 5_000, ...options });

  async function activeVersion(): Promise<number | null> {
    const [tickets, knowledge] = await Promise.all(
      searchCollections.map((collection) =>
        readIndexAliasTarget(request, searchIndexes[collection]),
      ),
    );
    if (tickets === null && knowledge === null) return null;
    const version = Number(/^smartdesk-tickets-v([1-9]\d*)$/.exec(tickets ?? '')?.[1]);
    if (!Number.isSafeInteger(version) || knowledge !== searchGeneration(version).knowledge) {
      throw new SearchSetupError(
        'Ticket and knowledge aliases must point to the same index generation',
      );
    }
    return version;
  }

  async function owner(index: string): Promise<string | null> {
    try {
      return await request({
        path: `${index}/_mapping`,
        method: 'GET',
        retry: false,
        decode(body) {
          const parsed = metadataResponse.safeParse(body);
          const mapping = parsed.success ? parsed.data[index]?.mappings : undefined;
          if (!mapping) throw new SearchError('invalid_response');
          // An existing index without a valid rebuild marker does not belong to this invocation.
          return mapping.dynamic === 'strict' ? (mapping._meta?.smartdesk_rebuild_id ?? '') : '';
        },
      });
    } catch (error) {
      if (error instanceof SearchError && error.status === 404) return null;
      throw error;
    }
  }

  async function ensureTargets(version: number, buildId: string, create = false) {
    const targets = searchGeneration(version);
    for (const collection of searchCollections) {
      const name = targets[collection];
      const existing = await owner(name);
      if (existing === buildId) continue;
      if (existing !== null || !create) {
        throw new SearchSetupError(`Index ${name} does not match the recorded rebuild`);
      }
      await request({
        path: name,
        method: 'PUT',
        retry: false,
        body: {
          mappings: {
            ...searchIndexes[collection].mappings,
            _meta: { smartdesk_rebuild_id: buildId },
          },
        },
        decode: acknowledgeIndexChange,
      });
    }
  }

  async function liveCounts(version: number): Promise<{ tickets: number; articles: number }> {
    const targets = searchGeneration(version);
    await request({
      path: `${targets.tickets},${targets.knowledge}/_refresh`,
      method: 'POST',
      retry: false,
      decode(body) {
        const parsed = shards.safeParse(body);
        if (!parsed.success || parsed.data._shards.failed)
          throw new SearchError('invalid_response');
      },
    });
    const count = (collection: SearchCollection) =>
      request({
        path: `${targets[collection]}/_count`,
        method: 'POST',
        retry: false,
        body: { query: liveSearchFilters[collection] },
        decode(body) {
          const parsed = countResponse.safeParse(body);
          if (!parsed.success || parsed.data._shards.failed)
            throw new SearchError('invalid_response');
          return parsed.data.count;
        },
      });
    const [tickets, articles] = await Promise.all([count('tickets'), count('knowledge')]);
    return { tickets, articles };
  }

  async function swap(sourceVersion: number | null, version: number) {
    const source = sourceVersion === null ? null : searchGeneration(sourceVersion);
    const target = searchGeneration(version);
    const actions = searchCollections.flatMap((collection) => {
      const index = searchIndexes[collection];
      const { read, write } = aliasProperties(index);
      const remove = source
        ? [index.readAlias, index.writeAlias].map((alias) => ({
            remove: { index: source[collection], alias, must_exist: true },
          }))
        : [];
      return [
        ...remove,
        { add: { index: target[collection], alias: index.readAlias, ...read } },
        { add: { index: target[collection], alias: index.writeAlias, ...write } },
      ];
    });
    await request({
      path: '_aliases?cluster_manager_timeout=4s&timeout=4s',
      method: 'POST',
      body: { actions },
      retry: false,
      decode: acknowledgeIndexChange,
    });
  }

  return { activeVersion, ensureTargets, liveCounts, swap };
}

export type SearchRebuildAdmin = ReturnType<typeof createSearchRebuildAdmin>;
