import type { ArticlePage, KnowledgeSearchResultDto } from '@smartdesk/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppOptions } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { ARTICLES, CATEGORIES, USERS, uuid } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createKnowledgeService } from '../../src/modules/knowledge/service.js';
import { createSearchBulkClient } from '../../src/modules/search/bulk.js';
import { createSearchClient, type SearchClient } from '../../src/modules/search/client.js';
import { searchIndexes } from '../../src/modules/search/indexes.js';
import { initializeSearchIndexes } from '../../src/modules/search/initialize.js';
import { knowledgeSearchSelect, projectKnowledge } from '../../src/modules/search/projection.js';
import { SearchError } from '../../src/modules/search/transport.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({});
const tokens = new TokenService(env);
const testSearchUrl = process.env.TEST_OPENSEARCH_URL;
const hit = (id: string, score: number, revision = 1) => ({ id, sort: [score, id], revision });

function appWith(prisma: NonNullable<AppOptions['prisma']>, options: Partial<AppOptions> = {}) {
  return buildApp({
    env,
    prisma,
    checkDb: async () => true,
    checkCache: async () => 'disabled',
    logger: false,
    ...options,
  });
}

async function search(
  app: FastifyInstance,
  q: string,
  filters: Record<string, string> = {},
  userId: string = USERS.erin,
): Promise<ArticlePage<KnowledgeSearchResultDto>> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge/search?${new URLSearchParams({ q, ...filters })}`,
    headers: { authorization: `Bearer ${await tokens.sign('access', userId, 0)}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data;
}

describe.skipIf(!testDatabaseUrl)('published knowledge search authorization and fallback', () => {
  const prisma = createTestPrisma();
  const engine = vi.fn<SearchClient['search']>();
  const service = createKnowledgeService(prisma);
  let app: FastifyInstance;
  let postgres: FastifyInstance;

  beforeAll(async () => {
    app = await appWith(prisma, { searchClient: { search: engine } });
    postgres = await appWith(prisma);
  });
  beforeEach(async () => {
    engine.mockReset();
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await Promise.all([app.close(), postgres.close()]);
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('drops draft, unpublished and revised text before returning summaries or counts', async () => {
    const forged = {
      ...hit(ARTICLES.vpn, 7),
      _source: { title: 'INDEX ONLY TITLE', body: 'INDEX ONLY BODY' },
      highlight: { body: ['INDEX ONLY HIGHLIGHT'] },
    };
    engine.mockImplementationOnce(async () => {
      await service.setPublished(ARTICLES.printer, false);
      await service.update(ARTICLES.password, {
        title: 'Changed title',
        body: 'Updated private text',
      });
      return [
        hit(ARTICLES.draft, 25),
        hit(ARTICLES.printer, 20),
        hit(ARTICLES.password, 15),
        forged,
      ];
    });
    const page = await search(app, 'fixture');
    expect(page).toEqual({
      items: [
        {
          id: ARTICLES.vpn,
          title: 'Fix a VPN that disconnects repeatedly',
          category: { id: CATEGORIES.network, name: 'Network/VPN' },
          preview: expect.stringMatching(/^If the VPN client drops every hour/),
          rank: 1,
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
      nextOffset: null,
    });
    const serialized = JSON.stringify(page);
    for (const denied of [
      ARTICLES.draft,
      ARTICLES.printer,
      ARTICLES.password,
      'INDEX ONLY',
      'Updated private text',
    ]) {
      expect(serialized).not.toContain(denied);
    }
  });

  it('requires both the current category and an indexed revision', async () => {
    await service.update(ARTICLES.printer, { categoryId: CATEGORIES.network });
    engine.mockImplementationOnce(async () => {
      await service.update(ARTICLES.printer, { categoryId: CATEGORIES.hardware });
      const { searchRevision } = await prisma.knowledgeArticle.findUniqueOrThrow({
        where: { id: ARTICLES.printer },
      });
      return [
        hit(ARTICLES.printer, 3, searchRevision),
        { id: ARTICLES.vpn, sort: [2, ARTICLES.vpn] },
      ];
    });
    const page = await search(app, 'printer', { categoryId: CATEGORIES.network }, USERS.admin);
    expect(page).toMatchObject({ items: [], total: 0, nextOffset: null });
    expect(engine).toHaveBeenCalledWith(
      'knowledge',
      expect.objectContaining({
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: 'printer',
                  fields: ['title^3', 'body'],
                  fuzziness: 'AUTO',
                  max_expansions: 8,
                },
              },
            ],
            filter: [{ term: { isPublished: true } }, { term: { categoryId: CATEGORIES.network } }],
          },
        },
        includeRevision: true,
        sort: [{ _score: 'desc' }, { articleId: 'asc' }],
      }),
    );
  });

  it('paginates the verified match set and preserves its total on an empty page', async () => {
    const discarded = Array.from({ length: 100 }, (_, i) => hit(uuid('article', 100 + i), 10));
    engine.mockImplementation(async (_collection, { searchAfter }) =>
      searchAfter
        ? [hit(ARTICLES.vpn, 1), hit(ARTICLES.printer, 1), hit(ARTICLES.draft, 1)]
        : discarded,
    );
    const first = await search(app, 'fixture', { limit: '1' });
    const second = await search(app, 'fixture', { limit: '1', offset: '1' });
    const past = await search(app, 'fixture', { limit: '1', offset: '1000' });
    expect(first).toMatchObject({
      items: [{ id: ARTICLES.vpn, rank: 1 }],
      total: 2,
      nextOffset: 1,
    });
    expect(second).toMatchObject({
      items: [{ id: ARTICLES.printer, rank: 0.5 }],
      total: 2,
      nextOffset: null,
    });
    expect(past).toEqual({ items: [], total: 2, limit: 1, offset: 1000, nextOffset: null });
    expect(engine).toHaveBeenCalledTimes(6);
    expect(engine).toHaveBeenNthCalledWith(
      2,
      'knowledge',
      expect.objectContaining({ searchAfter: discarded[99]!.sort }),
    );
  });

  it('falls back to the same PostgreSQL page on timeouts, invalid ordering or an incomplete scan', async () => {
    const expected = await search(postgres, 'vpn');
    expect(expected.items[0]?.id).toBe(ARTICLES.vpn);
    engine.mockRejectedValueOnce(new SearchError('timeout'));
    expect(await search(app, 'vpn')).toEqual(expected);
    engine.mockResolvedValueOnce([hit(ARTICLES.printer, 1), hit(ARTICLES.vpn, 1)]);
    expect(await search(app, 'vpn')).toEqual(expected);

    engine.mockClear().mockImplementation(async (_collection, { size }) => {
      const start = (engine.mock.calls.length - 1) * 100;
      return Array.from({ length: size }, (_, index) =>
        hit(uuid('article', 100 + start + index), 1),
      );
    });
    expect(await search(app, 'vpn')).toEqual(expected);
    expect(engine.mock.calls.map(([, request]) => request.size)).toEqual([100, 100, 100, 1]);
  });

  it('keeps PostgreSQL websearch operators and returns an empty page for punctuation', async () => {
    const query = '"vpn" or printer -spooler';
    expect(await search(app, query)).toEqual(await search(postgres, query));
    expect(await search(app, '%_*?')).toMatchObject({ items: [], total: 0 });
    expect(engine).not.toHaveBeenCalled();
  });
});

describe.skipIf(!testDatabaseUrl || !testSearchUrl)(
  'knowledge search API with real OpenSearch',
  () => {
    const prisma = createTestPrisma();
    const config = { enabled: true, url: testSearchUrl! } as const;
    const targets = Object.values(searchIndexes).map(({ name }) => name);
    let ownsTargets = false;
    let app: FastifyInstance;
    const raw = (method: string, path: string) =>
      fetch(new URL(path, config.url), { method, signal: AbortSignal.timeout(5000) });

    beforeAll(async () => {
      for (const target of targets) expect((await raw('HEAD', target)).status).toBe(404);
      ownsTargets = true;
    });
    beforeEach(async () => {
      await resetDatabase(prisma);
      await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
      await initializeSearchIndexes(config);
      const articles = await prisma.knowledgeArticle.findMany({ select: knowledgeSearchSelect });
      expect(await createSearchBulkClient(config)!.write(articles.map(projectKnowledge))).toEqual(
        articles.map(() => ({ ok: true })),
      );
      const refreshed = await raw('POST', `${searchIndexes.knowledge.name}/_refresh`);
      await refreshed.body?.cancel();
      expect(refreshed.ok).toBe(true);
      app = await appWith(prisma, {
        env: { ...env, openSearch: config },
        searchClient: createSearchClient(config, { timeoutMs: 3000 }),
      });
    }, 30_000);

    afterEach(async () => {
      await app?.close();
      if (ownsTargets) {
        for (const target of targets) {
          const removed = await raw('DELETE', target);
          await removed.body?.cancel();
        }
      }
    });
    afterAll(async () => {
      await resetDatabase(prisma);
      await prisma.$disconnect();
    });

    it('finds VPN and printer terms and misspellings with the existing response contract', async () => {
      for (const [term, id] of [
        ['vpn', ARTICLES.vpn],
        ['vnp', ARTICLES.vpn],
        ['printer', ARTICLES.printer],
        ['prinetr', ARTICLES.printer],
      ] as const) {
        const page = await search(app, term);
        expect(page.items[0]?.id, term).toBe(id);
        expect(page.items[0]).not.toHaveProperty('body');
      }
      const filtered = await search(app, 'vpn printer', { categoryId: CATEGORIES.hardware });
      expect(filtered.items.map(({ id }) => id)).toEqual([ARTICLES.printer]);
      const complete = await search(app, 'vpn printer');
      expect(complete.total).toBeGreaterThan(1);
      const first = await search(app, 'vpn printer', { limit: '1' });
      const second = await search(app, 'vpn printer', { limit: '1', offset: '1' });
      expect([...first.items, ...second.items]).toEqual(complete.items.slice(0, 2));
      expect(first.total).toBe(complete.total);
      expect(second.total).toBe(complete.total);
    });

    it('filters drafts and stale unpublishes, and falls back when the read alias disappears', async () => {
      const drafts = await search(app, 'onboarding');
      expect(drafts).toMatchObject({ items: [], total: 0 });
      await createKnowledgeService(prisma).setPublished(ARTICLES.printer, false);
      const upstream = createSearchClient(config)!;
      expect(
        await upstream.search('knowledge', {
          query: { term: { articleId: ARTICLES.printer } },
          size: 5,
        }),
      ).toEqual([{ id: ARTICLES.printer }]);
      expect(await search(app, 'printer')).toMatchObject({ items: [], total: 0 });

      const removed = await raw('DELETE', searchIndexes.knowledge.name);
      await removed.body?.cancel();
      expect(removed.ok).toBe(true);
      const page = await search(app, 'vpn');
      expect(page.items[0]?.id).toBe(ARTICLES.vpn);
    });
  },
);
