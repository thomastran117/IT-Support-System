import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ticketSearchResponseSchema } from '@smartdesk/contracts';
import { createPrisma, type PrismaClient } from '@smartdesk/db';
import { buildApp } from '../src/app.js';
import { TokenService } from '../src/auth/tokens.js';
import { loadEnv } from '../src/config/env.js';
import { USERS } from '../src/db/seed/fixtures.js';
import { submitTicket } from '../src/db/services/ticketService.js';
import { createPublishedKnowledgeSearch } from '../src/modules/knowledge/search.js';
import { createKnowledgeService } from '../src/modules/knowledge/service.js';
import { createSearchBulkClient } from '../src/modules/search/bulk.js';
import { createSearchClient, type SearchClient } from '../src/modules/search/client.js';
import { searchGeneration } from '../src/modules/search/indexes.js';
import { createSearchIndexWorker } from '../src/modules/search/indexWorker.js';
import { createSearchRebuild } from '../src/modules/search/rebuild.js';
import { createSearchRebuildAdmin } from '../src/modules/search/rebuildAdmin.js';
import {
  searchEvaluationQueries,
  seedSearchEvaluationCorpus,
  type EvaluationQuery,
} from '../test/fixtures/searchEvaluation.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const searchUrl = process.env.TEST_OPENSEARCH_URL;
const revision = process.env.SEARCH_BENCHMARK_REVISION;
const rounds = Number(process.env.SEARCH_BENCHMARK_ROUNDS ?? 20);
assert(
  databaseUrl && new URL(databaseUrl).pathname === '/smartdesk_search_benchmark_test',
  'Use a fresh smartdesk_search_benchmark_test database',
);
assert(searchUrl, 'Set TEST_OPENSEARCH_URL to the disposable Compose search node');
assert(
  revision && /^[a-f0-9]{40}$/.test(revision),
  'Set SEARCH_BENCHMARK_REVISION to the tested Git SHA',
);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100, 'Use 1 to 100 benchmark rounds');

const config = { enabled: true, url: searchUrl } as const;
const corpus = { tickets: 2500, articles: 500 };
const pollIntervalMs = 1000;
const visibilitySamplesPerCollection = 12;
const k = 3;
const engines = ['postgres', 'opensearch'] as const;
const collections = ['tickets', 'knowledge'] as const;
type Engine = (typeof engines)[number];
type Collection = (typeof collections)[number];

function percentiles(samples: number[]) {
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => Number(ordered[Math.ceil(p * ordered.length) - 1]!.toFixed(2));
  return { n: ordered.length, p50: percentile(0.5), p95: percentile(0.95) };
}

function relevance(ids: string[], labels: readonly string[]) {
  const first = ids.findIndex((id) => labels.includes(id));
  return {
    precisionAt3: ids.filter((id) => labels.includes(id)).length / k,
    reciprocalRankAt3: first === -1 ? 0 : 1 / (first + 1),
  };
}

async function openSearchInfo<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, config.url), { signal: AbortSignal.timeout(5000) });
  assert(response.ok, `OpenSearch resource probe returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function nodeResources() {
  const { nodes } = await openSearchInfo<{
    nodes: Record<
      string,
      {
        process: { cpu: { total_in_millis: number } };
        jvm: { mem: { heap_used_in_bytes: number; heap_max_in_bytes: number } };
      }
    >;
  }>('_nodes/stats/process,jvm');
  const values = Object.values(nodes);
  assert.equal(values.length, 1, 'Use the single-node Compose test profile');
  const { process, jvm } = values[0]!;
  return {
    cpuMs: process.cpu.total_in_millis,
    heapUsedBytes: jvm.mem.heap_used_in_bytes,
    heapMaxBytes: jvm.mem.heap_max_in_bytes,
  };
}

async function replaySearches(prisma: PrismaClient, client: SearchClient) {
  const env = loadEnv({});
  const tokens = new TokenService(env);
  const authorization = new Map(
    await Promise.all(
      Object.entries(USERS).map(
        async ([user, id]) => [user, `Bearer ${await tokens.sign('access', id, 0)}`] as const,
      ),
    ),
  );
  const options = {
    env,
    prisma,
    checkDb: async () => true,
    checkCache: async () => 'disabled' as const,
    logger: false as const,
    ticketSearchRateLimit: { max: 10_000, windowMs: 60_000 },
  };
  const postgres = await buildApp(options);
  const opensearch = await buildApp({ ...options, searchClient: client });
  const apps = { postgres, opensearch };
  const queries = searchEvaluationQueries.map((query) => ({
    query,
    postgres: [] as number[],
    opensearch: [] as number[],
  }));

  async function request(engine: Engine, { collection, user, q, filters }: EvaluationQuery) {
    const url = `/api/${collection}/search?${new URLSearchParams({ q, limit: String(k), ...filters })}`;
    const start = performance.now();
    const response = await apps[engine].inject({
      url,
      headers: { authorization: authorization.get(user)! },
    });
    const ms = performance.now() - start;
    assert.equal(response.statusCode, 200, `${engine} ${url}: ${response.body}`);
    const data = response.json().data;
    if (collection === 'tickets') {
      const page = ticketSearchResponseSchema.parse(data);
      assert.equal(page.mode, engine === 'postgres' ? 'fallback' : 'text', `${engine} ${url}`);
    }
    assert(Array.isArray(data.items));
    return { ms, ids: data.items.map(({ id }: { id: string }) => id) };
  }

  try {
    // Knowledge search keeps the engine private at the HTTP boundary. Verify its selected path
    // for each immutable input outside timing, then use the same adapter through each HTTP app.
    const searchKnowledge = createPublishedKnowledgeSearch(prisma, client);
    for (const { query } of queries) {
      if (query.collection === 'knowledge') {
        const checked = await searchKnowledge({
          query: query.q,
          categoryId: query.filters?.categoryId,
          limit: k,
          offset: 0,
        });
        assert.equal(checked.engine, 'opensearch', query.q);
      }
    }
    for (let warmup = 0; warmup < 3; warmup++) {
      for (const { query } of queries) {
        for (const engine of engines) await request(engine, query);
      }
    }
    const results: Record<Engine, string[]>[] = [];
    for (const { query } of queries) {
      results.push({
        postgres: (await request('postgres', query)).ids,
        opensearch: (await request('opensearch', query)).ids,
      });
    }
    const before = await nodeResources();
    for (let round = 0; round < rounds; round++) {
      for (const [i, entry] of queries.entries()) {
        for (const engine of (round + i) % 2 === 0
          ? engines
          : (['opensearch', 'postgres'] as const)) {
          const { ms, ids } = await request(engine, entry.query);
          assert.deepEqual(ids, results[i]![engine], `${engine} ${entry.query.q} order changed`);
          entry[engine].push(ms);
        }
      }
    }
    const after = await nodeResources();
    const measurements = queries.map(({ query, postgres, opensearch }, i) => ({
      ...query,
      postgres: {
        ...percentiles(postgres),
        ids: results[i]!.postgres,
        ...relevance(results[i]!.postgres, query.relevant),
      },
      opensearch: {
        ...percentiles(opensearch),
        ids: results[i]!.opensearch,
        ...relevance(results[i]!.opensearch, query.relevant),
      },
    }));
    const summary = Object.fromEntries(
      collections.map((collection) => [
        collection,
        Object.fromEntries(
          engines.map((engine) => {
            const matching = measurements.filter((item) => item.collection === collection);
            const subset = matching.map((item) => item[engine]);
            const mean = (field: 'precisionAt3' | 'reciprocalRankAt3') =>
              Number(
                (subset.reduce((sum, item) => sum + item[field], 0) / subset.length).toFixed(4),
              );
            return [
              engine,
              {
                ...percentiles(
                  queries
                    .filter((item) => item.query.collection === collection)
                    .flatMap((item) => item[engine]),
                ),
                precisionAt3: mean('precisionAt3'),
                mrrAt3: mean('reciprocalRankAt3'),
              },
            ];
          }),
        ),
      ]),
    );
    return {
      summary,
      queries: measurements,
      searchNode: { before, after, timedCpuMs: after.cpuMs - before.cpuMs },
    };
  } finally {
    await Promise.all([postgres.close(), opensearch.close()]);
  }
}

async function measureVisibility(prisma: PrismaClient, client: SearchClient) {
  const worker = createSearchIndexWorker({
    prisma,
    bulk: createSearchBulkClient(config)!,
    pollIntervalMs,
  });
  const knowledge = createKnowledgeService(prisma);
  const samples: Record<Collection, number[]> = { tickets: [], knowledge: [] };
  worker.start();
  try {
    for (let i = 0; i < visibilitySamplesPerCollection; i++) {
      await delay((i * 173) % pollIntervalMs);
      const { ticket } = await submitTicket(prisma, {
        requesterId: USERS.erin,
        title: `Visibility probe ${i + 1}`,
        description: 'Synthetic indexing lag ticket.',
      });
      samples.tickets.push(await waitForVisible(client, 'tickets', 'id', ticket.id));
      const draft = await knowledge.create({
        title: `Visibility probe ${i + 1}`,
        body: 'Synthetic indexing lag article.',
      });
      await knowledge.setPublished(draft.id, true);
      samples.knowledge.push(await waitForVisible(client, 'knowledge', 'articleId', draft.id));
    }
  } finally {
    await worker.stop();
  }
  return {
    workerPollMs: pollIntervalMs,
    observationPollMs: 50,
    tickets: percentiles(samples.tickets),
    knowledge: percentiles(samples.knowledge),
  };
}

async function waitForVisible(
  client: SearchClient,
  collection: Collection,
  key: string,
  id: string,
) {
  const committed = performance.now();
  while (performance.now() - committed < 10_000) {
    const hits = await client.search(collection, { query: { term: { [key]: id } }, size: 1 });
    if (hits.some((hit) => hit.id === id)) return performance.now() - committed;
    await delay(50);
  }
  throw new Error(`${collection} probe did not become searchable in 10 seconds`);
}

const prisma = createPrisma(databaseUrl);
try {
  const admin = createSearchRebuildAdmin(config);
  assert.equal(await prisma.user.count(), 0, 'The benchmark database must be empty');
  assert.equal(
    await admin.activeVersion(),
    null,
    'The benchmark search node must have no active generation',
  );
  await seedSearchEvaluationCorpus(prisma, databaseUrl, corpus);
  const version = 1;
  const targets = searchGeneration(version);
  const bulk = createSearchBulkClient(config, { targets })!;
  const start = performance.now();
  const rebuilt = await createSearchRebuild({ prisma, admin, bulk, version }).run();
  const backfillMs = Math.round(performance.now() - start);
  assert.equal(rebuilt.phase, 'COMPLETED');
  const published = await prisma.knowledgeArticle.count({ where: { isPublished: true } });
  const articles = await prisma.knowledgeArticle.count();
  await prisma.$executeRaw`ANALYZE tickets, knowledge_articles`;

  const [postgres] = await prisma.$queryRaw<
    {
      version: string;
      ticketsBytes: number;
      knowledgeBytes: number;
      ticketFtsBytes: number;
      knowledgeFtsBytes: number;
    }[]
  >`SELECT current_setting('server_version') AS version,
    pg_total_relation_size('tickets')::int AS "ticketsBytes",
    pg_total_relation_size('knowledge_articles')::int AS "knowledgeBytes",
    pg_relation_size('idx_tickets_fts')::int AS "ticketFtsBytes",
    pg_relation_size('idx_knowledge_articles_fts')::int AS "knowledgeFtsBytes"`;
  const { version: opensearch } = await openSearchInfo<{
    version: { number: string; lucene_version: string };
  }>('');
  const { indices } = await openSearchInfo<{
    indices: Record<string, { primaries: { store: { size_in_bytes: number } } }>;
  }>(`${targets.tickets},${targets.knowledge}/_stats/store`);
  const client = createSearchClient(config)!;
  const retrieval = await replaySearches(prisma, client);
  const visibility = await measureVisibility(prisma, client);
  console.log(
    JSON.stringify(
      {
        revision,
        node: process.version,
        rounds,
        k,
        dataset: { tickets: rebuilt.verifiedTickets, articles, published, background: corpus },
        backfillMs,
        postgres,
        opensearch: {
          version: opensearch.number,
          lucene: opensearch.lucene_version,
          ticketsBytes: indices[targets.tickets]!.primaries.store.size_in_bytes,
          knowledgeBytes: indices[targets.knowledge]!.primaries.store.size_in_bytes,
        },
        ...retrieval,
        visibility,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
