# Redis outage, concurrency and performance evaluation

How we verified the claims the rest of epic E12 (Redis infrastructure and distributed caching,
SD-067 through SD-073) makes about itself: that PostgreSQL stays authoritative no matter
what Redis is doing, that the rate limiter's degraded mode is bounded rather than open, and what
caching actually buys in latency and database load. Code lives in `backend/scripts/evaluate-cache.ts`
(the benchmark) and `backend/test/integration/` (the correctness tests this report relies on); the
benchmark command is `npm run bench:cache`.

## What is measured, and by what

| Claim                                                         | How it is checked                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A cache outage never loses ticket or audit data               | `backend/test/integration/redisOutageDurability.integration.test.ts` (gating) and the benchmark's "Ticket/audit durability" section (manual)                        |
| Reference-data and report reads still work when Redis is down | Same two, plus `backend/test/integration/cache.integration.test.ts` ("fails fast within the bounded timeout")                                                       |
| The degraded rate-limit mode is bounded, never unlimited      | `backend/test/integration/distributedRateLimit.integration.test.ts` ("still enforces a bounded limit...") and the benchmark's "degraded mode" line                  |
| Concurrent identical misses do not stampede PostgreSQL        | `backend/test/unit/cache/cacheAside.test.ts` and the cross-process case in `cache.integration.test.ts` ("protects against a stampede...")                           |
| Invalidation is correct under a concurrent write              | `backend/test/unit/cache/cacheAside.test.ts` ("never serves a stale refill...") and `teamsCategoriesCache.integration.test.ts` / `reportsCache.integration.test.ts` |
| A dropped connection recovers (restart, client-observable)    | `cache.integration.test.ts` ("recovers once a dropped connection reconnects")                                                                                       |
| Disabled Redis changes nothing but `/health/ready`            | `backend/test/integration/health.integration.test.ts`                                                                                                               |
| Cross-instance rate-limit sharing                             | `distributedRateLimit.integration.test.ts` ("shares one quota across two backend instances") and the benchmark                                                      |
| Cached vs. uncached latency and DB-query-count                | `evaluate-cache.ts` only (a benchmark, not a pass/fail test)                                                                                                        |

The first six rows are regression tests that already run in every CI pass (`npm run test:unit`,
`npm run test:integration`) and gate the build. The benchmark is not a gate -- it reports numbers,
the same way `docs/ai-evaluation.md` does for AI accuracy.

## Running it

```sh
# The correctness tests (already part of CI; this just shows how to run them alone)
REDIS_URL=redis://localhost:6379 TEST_DATABASE_URL=postgres://... \
  npm --prefix backend run test:integration -- cache redisOutageDurability distributedRateLimit

# The benchmark, against the project's own disposable CI containers
docker compose --profile ci up -d postgres-ci redis-ci
GIT_SHA=$(git rev-parse --short HEAD) \
  docker compose --profile ci run --rm -e GIT_SHA backend-ci \
  sh -c "npm --prefix backend run bench:cache -- --requests 30 --out-md /tmp/redis-eval.md && cat /tmp/redis-eval.md"
```

`bench:cache` truncates and reseeds whatever `TEST_DATABASE_URL` points at (the `test` fixture
profile) and needs a real, disposable `REDIS_URL` -- point both only at throwaway instances, never
at anything you care about. It exits non-zero if the ticket/audit durability check fails; every
other section is a reported measurement, not a gate.

## Results

Captured 2026-11-23 from commit `0c79b08` (the tip of `main` this epic's SD-073 branch, `a8fa6c3`,
built on; SD-073's own changes add tests/docs/the benchmark script itself and do not alter any of
the application code paths being measured), against this project's `postgres-ci`/`redis-ci`
Compose services, 30 requests per case.

### Reference data and report reads: baseline vs. cached

| Endpoint                   | Variant  | p50 (ms) | p95 (ms) | min  | max    | cache-aside `fetch()` calls (of 30 requests) |
| -------------------------- | -------- | -------- | -------- | ---- | ------ | -------------------------------------------- |
| GET /api/teams             | no cache | 3.13     | 15.70    | 2.41 | 103.25 | 30 (every request)                           |
| GET /api/teams             | cached   | 2.72     | 6.19     | 2.00 | 23.35  | 1 (29 served from cache)                     |
| GET /admin/reports/summary | no cache | 7.58     | 46.61    | 4.80 | 83.34  | 210 (7 sub-queries x 30)                     |
| GET /admin/reports/summary | cached   | 2.71     | 5.18     | 2.05 | 8.63   | 7 (203 served from cache)                    |

"`fetch()` calls" is a repository-invocation count, not a literal SQL statement count -- see
[`docs/architecture.md#caching`](architecture.md#caching) for what each repository function actually
issues per call. `app.inject()` is in-process (no real socket/TLS hop), so these latencies isolate
application and database time; they are not a production network-latency measurement, and at this
request count the p95 figures in particular are noisy (a handful of samples each) -- read them as
"the cached path's tail is no worse than the uncached one," not as precise percentiles.

The clearest, least noisy signal here is the `fetch()` column: the admin summary report runs 7
independent sub-queries per request, so 30 uncached requests make 210 repository calls against
PostgreSQL; cached, the first request makes 7 (one per sub-query, all against generation `v0`) and
the next 29 requests make zero -- a 30x reduction in repository calls for that endpoint at this
request count, growing with however many repeat requests land inside the 30s report TTL / 60s
reference-data TTL.

### Rate limiting across two API instances

- Shared Redis-backed quota of 5, 8 login attempts alternated across two separate `buildApp`
  instances (each with its own Redis connection, as two real backend processes would have): **5
  succeeded, 3 were 429** -- exactly the shared budget, not 5 _per instance_. Total wall time for
  the 8 round trips: 255.76 ms.
- Degraded mode (Redis pointed at an unreachable host, 2-request local fallback budget): status
  codes for 4 consecutive login attempts were `200, 200, 429, 429` -- bounded, never unlimited.
  This is the same behavior `distributedRateLimit.integration.test.ts` asserts as a hard pass/fail
  check; the benchmark just re-demonstrates it alongside the latency numbers above.

### Ticket/audit durability during a cache outage

- `POST /api/tickets`, cache pointed at an unreachable host (a real `createRedisCache`, not merely
  "disabled" -- every cache operation genuinely fails): **HTTP 201**.
- Ticket row present in PostgreSQL: **true**. `CREATED` audit event present: **true**.
- **Result: PASS.**

Ticket creation does not read or write the cache at all today (only team/category reference reads
and admin report reads are cache-aside -- see `docs/architecture.md#caching`), so this result mainly
confirms there is no _hidden_ coupling: the write path needs no coordination with Redis and
succeeds unconditionally while it is down, exactly as the architecture intends. The same outage also
leaves reference-data and report reads working (`GET /api/teams`, `GET /admin/reports/summary` both
still return 200), per the "fails fast... falls through" tests above.

## Limitations

- **No automated container-level restart.** `backend-ci` has no Docker socket access, so this
  script cannot itself run `docker compose restart redis-ci` mid-benchmark.
  `cache.integration.test.ts`'s "recovers once a dropped connection reconnects" test covers the
  client-observable equivalent (an abrupt connection loss and reconnect, the same
  `createRedisConnection` machinery `createRedisCache` is built on). To observe a real container
  restart by hand: run `docker compose --profile ci restart redis-ci` in a second terminal while
  `bench:cache` is mid-run, and watch for a brief burst of fallback-to-PostgreSQL latency with no
  errors, then automatic recovery -- this was done once manually during SD-073's development and
  behaved exactly as expected, but is not captured as a reproducible, scripted number here.
- **In-process HTTP.** `app.inject()` skips the real socket/TLS layer; absolute latency numbers
  would be higher, and look different, over a real network.
- **Single run, single machine, seeded fixture data.** Treat every number above as a relative
  comparison (cached vs. uncached, shared vs. isolated quota) on this run, not an absolute
  production figure. Re-run `bench:cache` to get current numbers; do not assume these are stable
  across hardware, Redis/PostgreSQL versions, or dataset size.
- **30 requests per case is small.** It is enough to make the `fetch()`-count reduction and the
  bounded-vs-unbounded rate-limit behavior unambiguous, but the p95 latency figures above should
  not be read as precise percentiles (see note under the first table).
