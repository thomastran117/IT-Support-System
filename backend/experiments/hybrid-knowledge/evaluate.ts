import assert from 'node:assert/strict';
import { createPrisma, type PrismaClient } from '@smartdesk/db';
import { z } from 'zod';
import { buildFixtures } from '../../src/db/seed/fixtures.js';
import { createPublishedKnowledgeSearch } from '../../src/modules/knowledge/search.js';
import { createSearchBulkClient } from '../../src/modules/search/bulk.js';
import { createSearchClient } from '../../src/modules/search/client.js';
import { searchGeneration } from '../../src/modules/search/indexes.js';
import { createSearchRebuild } from '../../src/modules/search/rebuild.js';
import { createSearchRebuildAdmin } from '../../src/modules/search/rebuildAdmin.js';
import { createSearchTransport } from '../../src/modules/search/transport.js';
import { additionalEvaluationArticles } from '../../test/fixtures/searchEvaluation.js';
import { openLocalEncoder } from './encoder.js';
import {
  createHybridEvaluationSearch,
  createSemanticIndex,
  dimensions,
  modelId,
  modelRevision,
  resultLimit,
  semanticIndexName,
} from './hybrid.js';
import { hybridQueries } from './queries.js';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.TEST_OPENSEARCH_URL;
const revision = process.env.SEARCH_BENCHMARK_REVISION;
const rounds = Number(process.env.HYBRID_EVALUATION_ROUNDS ?? 20);
assert(databaseUrl, 'Use the hybrid-experiment Compose service');
const database = new URL(databaseUrl);
assert(
  database.hostname === 'postgres-ci' && database.pathname === '/smartdesk_hybrid_knowledge_test',
  'Use the disposable Compose hybrid experiment database',
);
assert(searchUrl === 'http://opensearch:9200/', 'Use the internal Compose search node');
assert(
  revision && /^[a-f0-9]{40}$/.test(revision),
  'Set SEARCH_BENCHMARK_REVISION to the tested Git SHA',
);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100, 'Use 1 to 100 evaluation rounds');
const config = { enabled: true, url: searchUrl } as const;
const engines = ['lexical', 'hybrid'] as const;
type Engine = (typeof engines)[number];
type Query = (typeof hybridQueries)[number];

async function seedArticles(prisma: PrismaClient) {
  assert.equal(await prisma.knowledgeArticle.count(), 0, 'Use an empty test database');
  const base = buildFixtures('test');
  const articles = [...base.articles, ...additionalEvaluationArticles(500)];
  await prisma.$transaction([
    prisma.ticketCategory.createMany({ data: base.categories }),
    prisma.knowledgeArticle.createMany({ data: articles }),
  ]);
  return articles.length;
}

function latencies(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => Number(sorted[Math.ceil(sorted.length * p) - 1]!.toFixed(2));
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

function quality(ids: string[], relevant: readonly string[]) {
  const first = ids.findIndex((id) => relevant.includes(id));
  return {
    precisionAt3: ids.filter((id) => relevant.includes(id)).length / resultLimit,
    reciprocalRankAt3: first < 0 ? 0 : 1 / (first + 1),
  };
}

async function evaluate(
  prisma: PrismaClient,
  encoder: Awaited<ReturnType<typeof openLocalEncoder>>,
) {
  const lexical = createPublishedKnowledgeSearch(prisma, createSearchClient(config));
  const semantic = createSemanticIndex(config);
  const indexStart = performance.now();
  const index = await semantic.build(prisma, encoder.embed);
  const vectorIndexMs = performance.now() - indexStart;
  const hybrid = createHybridEvaluationSearch(prisma, lexical, {
    embed: encoder.embed,
    search: semantic.search,
  });

  async function run(engine: Engine, { q, categoryId }: Query) {
    const start = performance.now();
    if (engine === 'hybrid') {
      const result = await hybrid(q, categoryId);
      assert.equal(result.mode, 'hybrid', `Unexpected hybrid fallback for ${q}`);
      return { ids: result.ids, ms: performance.now() - start };
    }
    const result = await lexical({ query: q, categoryId, limit: resultLimit, offset: 0 });
    assert.equal(result.engine, 'opensearch', `Unexpected lexical fallback for ${q}`);
    return { ids: result.hits.map(({ id }) => id), ms: performance.now() - start };
  }

  const cases: {
    query: Query;
    ids: Record<Engine, string[]>;
    timings: Record<Engine, number[]>;
  }[] = [];
  for (const query of hybridQueries) {
    const ids: Record<Engine, string[]> = { lexical: [], hybrid: [] };
    for (let i = 0; i < 3; i++) {
      for (const engine of engines) ids[engine] = (await run(engine, query)).ids;
    }
    cases.push({ query, ids, timings: { lexical: [], hybrid: [] } });
  }

  for (let round = 0; round < rounds; round++) {
    for (const [i, { query, ids, timings }] of cases.entries()) {
      for (const engine of (round + i) % 2 === 0 ? engines : (['hybrid', 'lexical'] as const)) {
        const result = await run(engine, query);
        assert.deepEqual(result.ids, ids[engine], `Unstable results for ${engine} ${query.q}`);
        timings[engine].push(result.ms);
      }
    }
  }

  const summary = Object.fromEntries(
    ['all', 'sd-085', 'paraphrase'].map((group) => {
      const subset = cases.filter(({ query }) => group === 'all' || query.group === group);
      return [
        group,
        Object.fromEntries(
          engines.map((engine) => {
            const measures = subset.map(({ ids, query }) => quality(ids[engine], query.relevant));
            const mean = (field: keyof ReturnType<typeof quality>) =>
              Number(
                (
                  measures.reduce((total, value) => total + value[field], 0) / measures.length
                ).toFixed(4),
              );
            return [
              engine,
              {
                ...latencies(subset.flatMap(({ timings }) => timings[engine])),
                precisionAt3: mean('precisionAt3'),
                mrrAt3: mean('reciprocalRankAt3'),
              },
            ];
          }),
        ),
      ];
    }),
  );
  return {
    index: { ...index, totalMs: vectorIndexMs },
    summary,
    queries: cases.map(({ query, ids, timings }) => ({
      ...query,
      lexical: {
        ids: ids.lexical,
        ...quality(ids.lexical, query.relevant),
        ...latencies(timings.lexical),
      },
      hybrid: {
        ids: ids.hybrid,
        ...quality(ids.hybrid, query.relevant),
        ...latencies(timings.hybrid),
      },
    })),
  };
}

const prisma = createPrisma(databaseUrl);
try {
  const admin = createSearchRebuildAdmin(config);
  assert.equal(await admin.activeVersion(), null, 'Use an empty Compose OpenSearch project');
  const articles = await seedArticles(prisma);
  const lexicalIndex = await createSearchRebuild({
    prisma,
    admin,
    bulk: createSearchBulkClient(config, { targets: searchGeneration(1) })!,
    version: 1,
  }).run();
  assert.equal(lexicalIndex.verifiedTickets, 0);
  const before = performance.now();
  const cpuStart = process.cpuUsage();
  const encoder = await openLocalEncoder('/models');
  const modelLoadMs = performance.now() - before;
  try {
    const results = await evaluate(prisma, encoder);
    assert.equal(lexicalIndex.verifiedArticles, results.index.articles);
    const cpu = process.cpuUsage(cpuStart);
    const request = createSearchTransport(config);
    const storeResponse = z.object({
      _all: z.object({
        primaries: z.object({
          store: z.object({ size_in_bytes: z.int().nonnegative() }),
        }),
      }),
    });
    const store = await request({
      method: 'GET',
      path: `${semanticIndexName}/_stats/store`,
      retry: false,
      decode: (value) => storeResponse.parse(value)._all.primaries.store.size_in_bytes,
    });
    const identity = await request({
      method: 'GET',
      path: '',
      retry: false,
      decode: (value) =>
        z.object({ version: z.object({ number: z.string() }) }).parse(value).version.number,
    });
    console.log(
      JSON.stringify(
        {
          revision,
          modelId,
          modelRevision,
          dimensions,
          rounds,
          articles,
          node: process.version,
          opensearch: identity,
          modelLoadMs,
          vectorStoreBytes: store,
          paidProviderRequests: 0,
          processCpuMs: (cpu.user + cpu.system) / 1000,
          peakProcessRssKiB: process.resourceUsage().maxRSS,
          ...results,
        },
        null,
        2,
      ),
    );
  } finally {
    await encoder.close();
  }
} finally {
  await prisma.$disconnect();
}
