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

async function collectCandidates(client: SearchClient, query: string, categoryId?: string) {
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
    const size = Math.min(CANDIDATE_BATCH, MAX_CANDIDATES + 1 - candidates.length);
    const hits = await client.search('knowledge', {
      query: body,
      size,
      sort: candidateOrder,
      searchAfter: after,
      includeRevision: true,
    });
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
    opts: PublishedSearchOptions,
  ): Promise<PublishedSearchResult> {
    const query = normalizeKnowledgeQuery(opts.query);
    if (!/[\p{L}\p{N}]/u.test(query)) return { hits: [], total: 0 };
    const fallback = () => searchPostgres(prisma, { ...opts, query });
    // Keep the reader API's quoted phrases, boolean OR and term exclusion semantics.
    if (!client || webSearchSyntax.test(query)) return fallback();

    let candidates;
    try {
      candidates = await collectCandidates(client, query, opts.categoryId);
    } catch (err) {
      if (!(err instanceof SearchError)) throw err;
      return fallback();
    }
    if (!candidates) return fallback();

    const ids = [...new Set(candidates.map(({ id }) => id.toLowerCase()))];
    const articles = await loadPublishedSearchArticles(prisma, ids, opts.categoryId);
    const remaining = new Map(articles.map((article) => [article.id, article]));
    const hits: SearchHit[] = [];
    for (const candidate of candidates) {
      const id = candidate.id.toLowerCase();
      const article = remaining.get(id);
      if (!article || article.revision !== candidate.revision) continue;
      // Derive the public rank from verified result order. The index score stays internal.
      hits.push({
        id,
        title: article.title,
        category: article.category,
        preview: article.preview,
        rank: 1 / (hits.length + 1),
      });
      remaining.delete(id);
    }
    return { hits: hits.slice(opts.offset, opts.offset + opts.limit), total: hits.length };
  };
}
