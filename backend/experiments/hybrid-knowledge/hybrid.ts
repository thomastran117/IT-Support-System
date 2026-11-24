import type { PrismaClient } from '@smartdesk/db';
import { z } from 'zod';
import type { OpenSearchConfig } from '../../src/config/env.js';
import {
  loadPublishedSearchArticles,
  normalizeKnowledgeQuery,
} from '../../src/db/repositories/knowledge.js';
import type { createPublishedKnowledgeSearch } from '../../src/modules/knowledge/search.js';
import { createSearchTransport } from '../../src/modules/search/transport.js';

export const semanticIndexName = 'smartdesk-experiment-knowledge-semantic-v1';
export const modelId = 'Xenova/all-MiniLM-L6-v2';
export const modelRevision = '751bff37182d3f1213fa05d7196b954e230abad9';
export const dimensions = 384;
export const resultLimit = 3;
const candidateLimit = 15;
const documentLimit = 1000;
const articleChars = 1000;
const batchSize = 16;
const rrfConstant = 20;

export type Embed = (texts: string[]) => Promise<number[][]>;
type Candidate = { id: string; revision: number };
type LexicalSearch = ReturnType<typeof createPublishedKnowledgeSearch>;
type SemanticSearch = (vector: number[], categoryId?: string) => Promise<Candidate[]>;

const vector = z
  .array(z.number().min(-1).max(1))
  .length(dimensions)
  .refine((values) => values.some((value) => value !== 0));
const shards = z.object({ failed: z.literal(0) });
const bulkResult = z.object({
  errors: z.literal(false),
  items: z.array(
    z.object({ index: z.object({ _id: z.guid(), status: z.int().min(200).max(299) }) }),
  ),
});
const vectorResult = z.object({
  timed_out: z.literal(false),
  _shards: shards,
  hits: z.object({
    hits: z
      .array(
        z.object({
          _id: z.guid(),
          fields: z.object({ revision: z.tuple([z.int().positive()]) }),
        }),
      )
      .max(candidateLimit),
  }),
});

export function createSemanticIndex(config: Extract<OpenSearchConfig, { enabled: true }>) {
  const admin = createSearchTransport(config, { timeoutMs: 5000 });
  const read = createSearchTransport(config);

  return {
    /** Populate a dedicated experiment index from one bounded, published-only snapshot. */
    async build(prisma: PrismaClient, embed: Embed) {
      const articles = await prisma.knowledgeArticle.findMany({
        where: { isPublished: true },
        select: { id: true, title: true, body: true, categoryId: true, searchRevision: true },
        take: documentLimit + 1,
        orderBy: { id: 'asc' },
      });
      if (articles.length > documentLimit)
        throw new Error('The semantic corpus exceeds 1,000 articles');
      await admin({
        method: 'PUT',
        path: semanticIndexName,
        retry: false,
        body: {
          settings: { index: { knn: false, number_of_shards: 1, number_of_replicas: 0 } },
          mappings: {
            dynamic: 'strict',
            _meta: { model: modelId, modelRevision, modelFormat: 'q8' },
            properties: {
              articleId: { type: 'keyword' },
              categoryId: { type: 'keyword' },
              revision: { type: 'long' },
              embedding: { type: 'knn_vector', dimension: dimensions },
            },
          },
        },
        decode: (body) => z.object({ acknowledged: z.literal(true) }).parse(body),
      });

      let embeddingMs = 0;
      for (let start = 0; start < articles.length; start += batchSize) {
        const batch = articles.slice(start, start + batchSize);
        const before = performance.now();
        const embeddings = z
          .array(vector)
          .length(batch.length)
          .parse(
            await embed(batch.map(({ title, body }) => `${title}\n${body}`.slice(0, articleChars))),
          );
        embeddingMs += performance.now() - before;
        const lines = batch.flatMap(({ id, categoryId, searchRevision }, i) => [
          JSON.stringify({ index: { _id: id } }),
          JSON.stringify({
            articleId: id,
            categoryId,
            revision: searchRevision,
            embedding: embeddings[i],
          }),
        ]);
        const response = await admin({
          method: 'POST',
          path: `${semanticIndexName}/_bulk`,
          body: `${lines.join('\n')}\n`,
          contentType: 'application/x-ndjson',
          retry: false,
          decode: (body) => bulkResult.parse(body),
        });
        if (
          response.items.length !== batch.length ||
          response.items.some(({ index }, i) => index._id !== batch[i]!.id)
        ) {
          throw new Error('The semantic index did not acknowledge the expected articles');
        }
      }
      await admin({
        path: `${semanticIndexName}/_refresh`,
        method: 'POST',
        retry: false,
        decode: (body) => z.object({ _shards: shards }).parse(body),
      });
      return { articles: articles.length, embeddingMs };
    },

    async search(embedding: number[], categoryId?: string): Promise<Candidate[]> {
      const response = await read({
        method: 'POST',
        path: `${semanticIndexName}/_search`,
        retry: false,
        body: {
          size: candidateLimit,
          track_total_hits: false,
          _source: false,
          docvalue_fields: ['revision'],
          sort: [{ _score: 'desc' }, { articleId: 'asc' }],
          query: {
            script_score: {
              query: categoryId ? { term: { categoryId } } : { match_all: {} },
              script: {
                lang: 'knn',
                source: 'knn_score',
                params: {
                  field: 'embedding',
                  query_value: vector.parse(embedding),
                  space_type: 'cosinesimil',
                },
              },
            },
          },
        },
        decode: (body) => vectorResult.parse(body),
      });
      return response.hits.hits.map(({ _id, fields }) => ({
        id: _id,
        revision: fields.revision[0],
      }));
    },
  };
}

function fuse(lexical: string[], semantic: string[]) {
  const scores = new Map<string, number>();
  for (const ranked of [lexical, semantic]) {
    for (const [i, id] of ranked.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (rrfConstant + i + 1));
    }
  }
  // Preserve lexical preference on equal scores, then use the ID as a total order.
  const lexicalRank = new Map(lexical.map((id, i) => [id, i]));
  return [...scores.keys()]
    .sort(
      (a, b) =>
        scores.get(b)! - scores.get(a)! ||
        (lexicalRank.get(a) ?? candidateLimit) - (lexicalRank.get(b) ?? candidateLimit) ||
        a.localeCompare(b),
    )
    .slice(0, resultLimit);
}

export function createHybridEvaluationSearch(
  prisma: PrismaClient,
  lexicalSearch: LexicalSearch,
  semantic: { embed: Embed; search: SemanticSearch },
) {
  return async (query: string, categoryId?: string) => {
    const lexical = await lexicalSearch({ query, categoryId, limit: candidateLimit, offset: 0 });
    const lexicalIds = lexical.hits.map(({ id }) => id);
    const fallback = { ids: lexicalIds.slice(0, resultLimit), mode: 'lexical' as const };
    // Preserve PostgreSQL fallback, quoted/boolean syntax, and empty input from the lexical adapter.
    if (lexical.engine !== 'opensearch') return fallback;

    let dense: Candidate[] = [];
    try {
      const [embedding] = z
        .array(vector)
        .length(1)
        .parse(await semantic.embed([normalizeKnowledgeQuery(query)]));
      dense = await semantic.search(embedding!, categoryId);
    } catch {
      // A failed model or index still goes through the final publication check.
    }

    // Check both ranked lists in one current PostgreSQL read before allowing either into fusion.
    const ids = [...new Set([...lexicalIds, ...dense.map(({ id }) => id)])];
    const current = await loadPublishedSearchArticles(prisma, ids, categoryId);
    const revisions = new Map(current.map(({ id, revision }) => [id, revision]));
    const currentLexical = lexicalIds.filter(
      (id) => revisions.has(id) && revisions.get(id) === lexical.revisions.get(id),
    );
    const currentDense = dense
      .filter(({ id, revision }) => revisions.get(id) === revision)
      .map(({ id }) => id);
    return currentDense.length
      ? { ids: fuse(currentLexical, currentDense), mode: 'hybrid' as const }
      : { ids: currentLexical.slice(0, resultLimit), mode: 'lexical' as const };
  };
}
