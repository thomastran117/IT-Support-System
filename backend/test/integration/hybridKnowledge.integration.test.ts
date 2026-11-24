import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHybridEvaluationSearch,
  createSemanticIndex,
  dimensions,
  semanticIndexName,
} from '../../experiments/hybrid-knowledge/hybrid.js';
import { ARTICLES, CATEGORIES } from '../../src/db/seed/fixtures.js';
import { createPublishedKnowledgeSearch } from '../../src/modules/knowledge/search.js';
import { createKnowledgeService } from '../../src/modules/knowledge/service.js';
import type { SearchClient } from '../../src/modules/search/client.js';
import { SearchError } from '../../src/modules/search/transport.js';
import {
  evaluationArticles as articles,
  seedSearchEvaluationCorpus,
} from '../fixtures/searchEvaluation.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const openSearchUrl = process.env.TEST_OPENSEARCH_URL;
const unit = (axis: number) => Array.from({ length: dimensions }, (_, i) => (i === axis ? 1 : 0));
const hit = (id: string, score: number, revision = 1) => ({ id, sort: [score, id], revision });

describe.skipIf(!testDatabaseUrl)('offline published knowledge hybrid retrieval', () => {
  const prisma = createTestPrisma();
  const lexical = (client?: SearchClient) => createPublishedKnowledgeSearch(prisma, client);

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedSearchEvaluationCorpus(prisma, testDatabaseUrl!);
  });
  afterAll(async () => {
    try {
      await resetDatabase(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('uses PostgreSQL alone when OpenSearch is disabled, down, or bypassed by keyword syntax', async () => {
    const embed = vi.fn(async () => [unit(0)]);
    const find = vi.fn(async () => []);
    const semantic = { embed, search: find };
    const postgres = createHybridEvaluationSearch(prisma, lexical(), semantic);
    expect(await postgres('relaycase', CATEGORIES.network)).toEqual({
      ids: [articles.network],
      mode: 'lexical',
    });
    const outage = createHybridEvaluationSearch(
      prisma,
      lexical({
        search: async () => {
          throw new SearchError('unavailable');
        },
      }),
      semantic,
    );
    expect(await outage('relaycase', CATEGORIES.network)).toEqual({
      ids: [articles.network],
      mode: 'lexical',
    });

    const keyword = vi.fn(async () => []);
    const quoted = createHybridEvaluationSearch(prisma, lexical({ search: keyword }), semantic);
    expect(await quoted('"relaycase"', CATEGORIES.network)).toEqual({
      ids: [articles.network],
      mode: 'lexical',
    });
    expect(keyword).not.toHaveBeenCalled();
    expect(await quoted('***')).toEqual({ ids: [], mode: 'lexical' });
    expect(embed).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('preserves the verified keyword order when the encoder or vector index fails', async () => {
    const client = { search: async () => [hit(articles.network, 3), hit(ARTICLES.vpn, 2)] };
    const missingIndex = async () => {
      throw new Error('vector index unavailable');
    };
    for (const [embed, search] of [
      [
        async () => {
          throw new Error('model unavailable');
        },
        async () => [],
      ],
      [async () => [[1, 1]], async () => []],
      [async () => [unit(0)], missingIndex],
    ] as const) {
      const hybrid = createHybridEvaluationSearch(prisma, lexical(client), { embed, search });
      expect(await hybrid('vpn')).toEqual({
        ids: [articles.network, ARTICLES.vpn],
        mode: 'lexical',
      });
    }
  });

  it('drops a revoked lexical hit even if the vector branch fails after unpublication', async () => {
    const kb = createKnowledgeService(prisma);
    const hybrid = createHybridEvaluationSearch(
      prisma,
      lexical({ search: async () => [hit(articles.network, 3)] }),
      {
        embed: async () => [unit(0)],
        search: async () => {
          await kb.setPublished(articles.network, false);
          throw new Error('vector index unavailable');
        },
      },
    );
    expect(await hybrid('relaycase')).toEqual({ ids: [], mode: 'lexical' });
  });

  it.skipIf(!openSearchUrl)(
    'indexes only published vectors, then filters stale revisions and categories at retrieval',
    async () => {
      const config = { enabled: true, url: openSearchUrl! } as const;
      const raw = (method: string, path: string) =>
        fetch(new URL(path, config.url), { method, signal: AbortSignal.timeout(5000) });
      expect((await raw('HEAD', semanticIndexName)).status).toBe(404);
      const embed = vi.fn(async (texts: string[]) =>
        texts.map((text) => unit(text.startsWith('Relaycase docking station') ? 0 : 1)),
      );
      const index = createSemanticIndex(config);
      try {
        expect(await index.build(prisma, embed)).toMatchObject({ articles: 8 });
        const encoded = embed.mock.calls.flatMap(([texts]) => texts);
        expect(encoded).toHaveLength(8);
        expect(encoded.join(' ')).not.toMatch(/draft canary|paper jam error/i);
        expect((await raw('HEAD', `${semanticIndexName}/_doc/${articles.draft}`)).status).toBe(404);
        const { embedding, ...stored } = await (
          await raw('GET', `${semanticIndexName}/_source/${articles.hardware}`)
        ).json();
        expect(stored).toEqual({
          articleId: articles.hardware,
          categoryId: CATEGORIES.hardware,
          revision: 1,
        });
        expect(embedding).toHaveLength(dimensions);
        expect((await index.search(unit(0), CATEGORIES.hardware))[0]?.id).toBe(articles.hardware);

        const keyword = { search: async () => [hit(ARTICLES.printer, 3)] };
        const hybrid = createHybridEvaluationSearch(prisma, lexical(keyword), {
          embed: async () => [unit(0)],
          search: index.search,
        });
        const before = await hybrid('external screen', CATEGORIES.hardware);
        expect(before.mode).toBe('hybrid');
        expect(before.ids).toContain(articles.hardware);

        const kb = createKnowledgeService(prisma);
        await kb.update(articles.ethernet, {
          body: 'The current article text replaces the indexed revision.',
        });
        await kb.setPublished(articles.hardware, false);
        await kb.update(ARTICLES.printer, { categoryId: CATEGORIES.network });
        expect((await index.search(unit(0), CATEGORIES.hardware)).map(({ id }) => id)).toContain(
          articles.hardware,
        );
        expect(await hybrid('external screen', CATEGORIES.hardware)).toEqual({
          ids: [],
          mode: 'lexical',
        });
      } finally {
        const response = await raw('DELETE', semanticIndexName);
        await response.body?.cancel();
        expect([200, 404]).toContain(response.status);
      }
    },
    20_000,
  );
});
