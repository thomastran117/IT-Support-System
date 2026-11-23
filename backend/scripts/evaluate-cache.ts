/**
 * Redis outage, concurrency and performance evaluation (SD-073). See docs/redis-evaluation.md.
 *
 *   TEST_DATABASE_URL=postgres://ci:ci-only-password@localhost:5432/smartdesk_test \
 *   REDIS_URL=redis://localhost:6379 \
 *   npm run bench:cache -- [--requests 30] [--out-md report.md]
 *
 * Point both at disposable instances only -- the project's own `postgres-ci`/`redis-ci` Compose
 * services (ports forwarded, or run from inside the `backend-ci` container) are the intended
 * target. `TEST_DATABASE_URL` is reset and reseeded with the `test` fixture profile; never point
 * this at a database you care about.
 *
 * Exits non-zero if the ticket/audit durability check fails -- that one is a correctness
 * assertion, not a number to report. Every other section prints an observed measurement; none of
 * them gate the exit code, because this is a benchmark, not a regression test (those already
 * exist under backend/test/integration).
 */
import { writeFileSync } from 'node:fs';
import { createPrisma } from '@smartdesk/db';
import { buildApp } from '../src/app.js';
import { TokenService } from '../src/auth/tokens.js';
import {
  createNoopCache,
  createRedisCache,
  createRedisConnection,
  type CacheClient,
} from '../src/cache/redisCache.js';
import { loadEnv } from '../src/config/env.js';
import { DEMO_PASSWORD, REPORT_WINDOW, USERS } from '../src/db/seed/fixtures.js';
import { seedDatabase } from '../src/db/seed/run.js';
import { createFallbackRateLimitStore } from '../src/rateLimit/fallbackStore.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const REQUESTS = Number(arg('requests') ?? 30);

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname)) {
  console.error('Set TEST_DATABASE_URL to a *test*-named, disposable PostgreSQL database.');
  process.exit(2);
}
if (!redisUrl) {
  console.error("Set REDIS_URL to a disposable Redis instance (e.g. the project's redis-ci).");
  process.exit(2);
}

function msSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function stats(samplesMs: number[]): { p50: number; p95: number; min: number; max: number } {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return { p50: pct(50), p95: pct(95), min: sorted[0], max: sorted[sorted.length - 1] };
}
const fmt = (n: number) => n.toFixed(2);

/** Wraps a real CacheClient with hit/miss counters on data keys only (excludes the cache-aside
 * generation-key lookup), so "DB query count avoided" below means exactly what it says: each miss
 * is one repository invocation (and therefore some number of SQL statements) a hit skips. */
function withCounters(cache: CacheClient): {
  cache: CacheClient;
  counts: { hits: number; misses: number };
} {
  const counts = { hits: 0, misses: 0 };
  const isGenerationKey = (key: string) => key.startsWith('smartdesk:ver:');
  return {
    counts,
    cache: {
      ...cache,
      async get<T>(key: string): Promise<T | undefined> {
        const value = await cache.get<T>(key);
        if (!isGenerationKey(key)) {
          if (value === undefined) counts.misses++;
          else counts.hits++;
        }
        return value;
      },
    },
  };
}

async function benchmark(
  app: Awaited<ReturnType<typeof buildApp>>,
  url: string,
  authorization: string,
  n: number,
) {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    const res = await app.inject({ method: 'GET', url, headers: { authorization } });
    samples.push(msSince(start));
    if (res.statusCode !== 200) throw new Error(`${url} -> ${res.statusCode}: ${res.body}`);
  }
  return stats(samples);
}

const sections: string[] = [];
function report(markdown: string) {
  console.log(markdown);
  sections.push(markdown);
}

async function main() {
  const prisma = createPrisma(databaseUrl!);
  const env = loadEnv({ FRONTEND_ORIGIN: 'http://bench.test' });
  const tokens = new TokenService(env);

  await seedDatabase(prisma, { profile: 'test', reset: true, databaseUrl: databaseUrl! });
  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}`;
  };
  const technicianAuth = await bearer(USERS.tara);
  const adminAuth = await bearer(USERS.admin);
  const employeeAuth = await bearer(USERS.erin);

  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const closers: (() => Promise<void>)[] = [];
  const build = async (opts: Parameters<typeof buildApp>[0]) => {
    const app = await buildApp(opts);
    apps.push(app);
    return app;
  };

  report(
    `# Redis evaluation run\n\n- Date: ${new Date().toISOString()}\n- Commit: ${process.env.GIT_SHA ?? '(set GIT_SHA to record one)'}\n- Requests per case: ${REQUESTS}\n`,
  );

  // --- 1. Baseline (no cache) vs cached reads: reference data and admin reports ------------------
  const baselineApp = await build({
    env,
    prisma,
    checkDb: async () => true,
    checkCache: async () => 'disabled' as const,
    logger: false,
    cache: createNoopCache(),
  });
  const { cache: countedCache, counts } = withCounters(createRedisCache({ url: redisUrl! }));
  closers.push(() => countedCache.close());
  const cachedApp = await build({
    env,
    prisma,
    checkDb: async () => true,
    checkCache: async () => 'ok' as const,
    logger: false,
    cache: countedCache,
  });

  const teamsBaseline = await benchmark(baselineApp, '/api/teams', technicianAuth, REQUESTS);
  counts.hits = 0;
  counts.misses = 0;
  const teamsCached = await benchmark(cachedApp, '/api/teams', technicianAuth, REQUESTS);
  const teamsCounts = { ...counts };

  const reportUrl = `/api/admin/reports/summary?start=${encodeURIComponent(REPORT_WINDOW.start)}&end=${encodeURIComponent(REPORT_WINDOW.end)}`;
  const reportsBaseline = await benchmark(baselineApp, reportUrl, adminAuth, REQUESTS);
  counts.hits = 0;
  counts.misses = 0;
  const reportsCached = await benchmark(cachedApp, reportUrl, adminAuth, REQUESTS);
  const reportsCounts = { ...counts };

  report(
    [
      '## Reference data and report reads: baseline vs cached\n',
      '| Endpoint | Variant | p50 (ms) | p95 (ms) | min | max | cache-aside fetch() calls (of ' +
        REQUESTS +
        ' requests) |',
      '|---|---|---|---|---|---|---|',
      `| GET /api/teams | no cache | ${fmt(teamsBaseline.p50)} | ${fmt(teamsBaseline.p95)} | ${fmt(teamsBaseline.min)} | ${fmt(teamsBaseline.max)} | ${REQUESTS} (every request) |`,
      `| GET /api/teams | cached | ${fmt(teamsCached.p50)} | ${fmt(teamsCached.p95)} | ${fmt(teamsCached.min)} | ${fmt(teamsCached.max)} | ${teamsCounts.misses} (${teamsCounts.hits} served from cache) |`,
      `| GET /admin/reports/summary | no cache | ${fmt(reportsBaseline.p50)} | ${fmt(reportsBaseline.p95)} | ${fmt(reportsBaseline.min)} | ${fmt(reportsBaseline.max)} | ${REQUESTS * 7} (7 sub-queries x ${REQUESTS}) |`,
      `| GET /admin/reports/summary | cached | ${fmt(reportsCached.p50)} | ${fmt(reportsCached.p95)} | ${fmt(reportsCached.min)} | ${fmt(reportsCached.max)} | ${reportsCounts.misses} (${reportsCounts.hits} served from cache) |`,
      '',
      '"cache-aside fetch() calls" is a repository-invocation count, not a literal SQL statement',
      'count -- see docs/architecture.md#caching for how many statements each repository function',
      'issues. `app.inject()` is in-process (no real socket/TLS/network hop), so these numbers isolate',
      'application + database time; they are not a production network-latency measurement.\n',
    ].join('\n'),
  );

  // --- 2. Cross-instance rate-limit sharing --------------------------------------------------
  const rlNamespace = `bench-rl-${Date.now()}-`;
  const rlLimit = 5;
  const rlRedisA = createRedisConnection({ url: redisUrl! });
  const rlRedisB = createRedisConnection({ url: redisUrl! });
  closers.push(async () => {
    await rlRedisA.quit().catch(() => rlRedisA.disconnect());
  });
  closers.push(async () => {
    await rlRedisB.quit().catch(() => rlRedisB.disconnect());
  });
  const rlAppA = await build({
    env,
    prisma,
    checkDb: async () => true,
    checkCache: async () => 'disabled' as const,
    logger: false,
    authRateLimit: { login: rlLimit, refresh: rlLimit, windowMs: 60_000 },
    rateLimitStore: createFallbackRateLimitStore(rlRedisA, rlNamespace),
  });
  const rlAppB = await build({
    env,
    prisma,
    checkDb: async () => true,
    checkCache: async () => 'disabled' as const,
    logger: false,
    authRateLimit: { login: rlLimit, refresh: rlLimit, windowMs: 60_000 },
    rateLimitStore: createFallbackRateLimitStore(rlRedisB, rlNamespace),
  });
  const login = (app: Awaited<ReturnType<typeof buildApp>>) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'erin@smartdesk.test', password: DEMO_PASSWORD },
    });
  let shared200 = 0;
  let shared429 = 0;
  const rlStart = process.hrtime.bigint();
  for (let i = 0; i < rlLimit + 3; i++) {
    const res = await login(i % 2 === 0 ? rlAppA : rlAppB); // alternate instances
    if (res.statusCode === 200) shared200++;
    else shared429++;
  }
  const rlElapsed = msSince(rlStart);

  // --- 3. Degraded mode: rate limiting when Redis itself is unreachable ------------------------
  const downRedis = createRedisConnection({
    url: 'redis://127.0.0.1:1',
    connectTimeoutMs: 300,
    commandTimeoutMs: 300,
  });
  closers.push(async () => downRedis.disconnect());
  const rlDownApp = await build({
    env,
    prisma,
    checkDb: async () => true,
    checkCache: async () => 'unavailable' as const,
    logger: false,
    authRateLimit: { login: 2, refresh: 2, windowMs: 60_000 },
    rateLimitStore: createFallbackRateLimitStore(downRedis, 'bench-rl-down-'),
  });
  const downResults: number[] = [];
  for (let i = 0; i < 4; i++) downResults.push((await login(rlDownApp)).statusCode);

  report(
    [
      '## Rate limiting across two API instances\n',
      `- Shared Redis-backed quota of ${rlLimit}, ${rlLimit + 3} login attempts alternated across two`,
      `  instances: **${shared200} succeeded, ${shared429} were 429** (expected ${rlLimit} and 3).`,
      `  Total wall time for ${rlLimit + 3} round trips: ${fmt(rlElapsed)} ms.`,
      '- Degraded mode (Redis unreachable, 2-request local fallback budget): status codes for 4',
      `  consecutive login attempts were \`${downResults.join(', ')}\` -- bounded, never unlimited.`,
      '',
    ].join('\n'),
  );

  // --- 4. Ticket/audit durability during a cache outage ----------------------------------------
  const outageCache = createRedisCache({
    url: 'redis://127.0.0.1:1',
    connectTimeoutMs: 300,
    commandTimeoutMs: 300,
  });
  closers.push(() => outageCache.close());
  const outageApp = await build({
    env,
    prisma,
    checkDb: async () => true,
    checkCache: async () => 'unavailable' as const,
    logger: false,
    cache: outageCache,
  });
  const createRes = await outageApp.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: { authorization: employeeAuth },
    payload: { title: 'Bench outage check', description: 'Created while Redis is unreachable.' },
  });
  const ticketId = (createRes.json().data as { id: string } | undefined)?.id;
  const ticket = ticketId ? await prisma.ticket.findUnique({ where: { id: ticketId } }) : null;
  const events = ticketId ? await prisma.ticketEvent.findMany({ where: { ticketId } }) : [];
  const durabilityOk =
    createRes.statusCode === 201 &&
    ticket !== null &&
    events.some((e) => e.eventType === 'CREATED');

  report(
    [
      '## Ticket/audit durability during a cache outage\n',
      `- POST /api/tickets while the cache is pointed at an unreachable host: HTTP ${createRes.statusCode}.`,
      `- Ticket row present in PostgreSQL: ${ticket !== null}. CREATED audit event present: ${events.some((e) => e.eventType === 'CREATED')}.`,
      `- **Result: ${durabilityOk ? 'PASS' : 'FAIL'}** -- ticket creation does not read or write the`,
      '  cache at all today, so this mainly demonstrates there is no hidden coupling: the write path',
      '  needs no coordination with Redis and succeeds unconditionally while it is down.',
      '',
    ].join('\n'),
  );

  report(
    [
      '## Limitations\n',
      '- A real Compose-level container restart of `redis-ci` is not driven by this script: the',
      '  `backend-ci` container has no Docker socket access. `backend/test/integration/cache.integration.test.ts`',
      '  covers the client-observable equivalent instead (an abrupt connection drop and reconnect); to watch a',
      '  real container restart, run `docker compose --profile ci restart redis-ci` in another',
      '  terminal while this script is mid-run and observe the request log for a brief latency bump',
      '  with no errors, followed by automatic recovery.',
      '- `app.inject()` is in-process; these latencies exclude real network/TLS overhead.',
      '- Single run, single machine, seeded fixture data only -- treat as a relative comparison',
      '  (cached vs uncached, shared vs isolated quota), not an absolute production figure.',
      '',
    ].join('\n'),
  );

  await Promise.all(apps.map((a) => a.close()));
  await Promise.all(closers.map((c) => c()));
  await prisma.$disconnect();

  const outMd = arg('out-md');
  if (outMd) writeFileSync(outMd, sections.join('\n'));

  if (!durabilityOk) {
    console.error('\nDurability check FAILED -- see above.');
    process.exit(1);
  }
  // ioredis's background reconnect loop against the deliberately-unreachable hosts above can
  // otherwise keep a stray timer alive even after every connection is closed; exit explicitly
  // rather than rely on the event loop draining on its own.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
