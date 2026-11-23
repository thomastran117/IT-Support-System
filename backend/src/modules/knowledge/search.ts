import type { PrismaClient } from '@smartdesk/db';
import { z } from 'zod';
import {
  loadPublishedSearchArticles,
  normalizeKnowledgeQuery,
  searchPublished as searchPostgres,
  type PublishedSearchOptions,
  type PublishedSearchResult,
  type SearchHit,
} from '../../db/repositories/knowledge.js';
import type { SearchClient, SearchCandidate } from '../search/client.js';
import { liveSearchFilters } from '../search/indexes.js';
import { SearchError } from '../search/transport.js';

const CANDIDATE_BATCH = 100;
const MAX_CANDIDATES = 300;
const candidateOrder = [{ _score: 'desc' }, { articleId: 'asc' }] as const;
const positionSchema = z.tuple([z.number().nonnegative(), z.guid()]);
const webSearchSyntax = /"|(?:^|\s)(?:or(?=\s|$)|-\S)/i;

type KnowledgeSearchOptions = Omit<PublishedSearchOptions, 'query'> & {
  /** A string uses reader search syntax. A term list matches any term in either engine. */
  query: string | readonly string[];
  /** Deadline for OpenSearch. PostgreSQL fallback runs after expiry. */
  signal?: AbortSignal;
};

export type KnowledgeSearchEngine = 'opensearch' | 'postgres' | 'none';

async function collectCandidates(
  client: SearchClient,
  query: string,
  { categoryId, signal }: KnowledgeSearchOptions,
) {
  const candidates: SearchCandidate[] = [];
  let after: z.infer<typeof positionSchema> | undefined;
  const filter: Record<string, unknown>[] = [liveSearchFilters.knowledge];
  if (categoryId) filter.push({ term: { categoryId: categoryId.toLowerCase() } });
  const body = {
    bool: {
      must: [
        {
          multi_match: {
            query,
            fields: ['title^3', 'body'],
            fuzziness: 'AUTO',
            max_expansions: 8,
          },
        },
      ],
      filter,
    },
  };

  // One sentinel beyond the scan budget distinguishes an exhausted query from a partial total.
  while (candidates.length <= MAX_CANDIDATES) {
    if (signal?.aborted) throw new SearchError('timeout');
    const size = Math.min(CANDIDATE_BATCH, MAX_CANDIDATES + 1 - candidates.length);
    const hits = await client.search('knowledge', {
      query: body,
      size,
      sort: candidateOrder,
      searchAfter: after,
      includeRevision: true,
      signal,
    });
    if (signal?.aborted) throw new SearchError('timeout');
    if (hits.length > size) throw new SearchError('invalid_response');
    for (const candidate of hits) {
      const parsed = positionSchema.safeParse(candidate.sort);
      if (!parsed.success || parsed.data[1] !== candidate.id)
        throw new SearchError('invalid_response');
      const next = parsed.data;
      if (after && (next[0] > after[0] || (next[0] === after[0] && next[1] <= after[1]))) {
        throw new SearchError('invalid_response');
      }
      candidates.push(candidate);
      after = next;
    }
    if (hits.length < size) return candidates;
  }
  return null;
}

/** Search only the current published knowledge base. PostgreSQL also verifies index matches. */
export function createPublishedKnowledgeSearch(prisma: PrismaClient, client?: SearchClient) {
  return async function searchPublished(
    opts: KnowledgeSearchOptions,
  ): Promise<PublishedSearchResult & { engine: KnowledgeSearchEngine }> {
    const input = opts.query;
    const query = normalizeKnowledgeQuery(typeof input === 'string' ? input : input.join(' '));
    if (!/[\p{L}\p{N}]/u.test(query))
      return { hits: [], total: 0, revisions: new Map(), engine: 'none' };
    const fallback = async () => ({
      ...(await searchPostgres(prisma, {
        ...opts,
        query: typeof input === 'string' ? query : input.join(' or '),
      })),
      engine: 'postgres' as const,
    });
    // Keep the reader API's quoted phrases, boolean OR and term exclusion semantics.
    if (!client || (typeof input === 'string' && webSearchSyntax.test(query))) return fallback();

    let candidates;
    try {
      candidates = await collectCandidates(client, query, opts);
    } catch (err) {
      if (!(err instanceof SearchError)) throw err;
      return fallback();
    }
    if (!candidates) return fallback();

    const ids = [...new Set(candidates.map(({ id }) => id.toLowerCase()))];
    const articles = await loadPublishedSearchArticles(prisma, ids, opts.categoryId);
    const remaining = new Map(articles.map((article) => [article.id, article]));
    const hits: SearchHit[] = [];
    const revisions = new Map<string, number>();
    let total = 0;
    for (const candidate of candidates) {
      const id = candidate.id.toLowerCase();
      const article = remaining.get(id);
      if (!article || article.revision !== candidate.revision) continue;
      remaining.delete(id);
      total += 1;
      if (total <= opts.offset || hits.length >= opts.limit) continue;
      // Derive the public rank from verified result order. The index score stays internal.
      hits.push({
        id,
        title: article.title,
        category: article.category,
        preview: article.preview,
        rank: 1 / total,
      });
      revisions.set(id, article.revision);
    }
    return { hits, total, revisions, engine: 'opensearch' };
  };
}
