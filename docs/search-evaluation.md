# Optional OpenSearch evaluation (SD-085)

## Measured results

The November 23, 2026 run used SHA `9d6f93b1fe61ac04c67019e8f1d092e13648a0c7` with
2,516 tickets and 510 articles, of which 458 were published. The environment used Docker Engine
29.9.2 via Docker Desktop on an ARM64 Snapdragon X Plus host. Docker had 8 CPUs and 7.55 GiB of
memory. The containers ran Node.js 22.23.5, PostgreSQL 16.15, and OpenSearch 3.10.0 with Lucene 10.6.0.
The run used 20 measured rounds per query and engine.

| Collection | Engine              | Requests | p50 (ms) | p95 (ms) | Precision@3 | MRR@3 |
| ---------- | ------------------- | -------: | -------: | -------: | ----------: | ----: |
| Tickets    | PostgreSQL FTS      |      160 |     7.77 |    14.41 |       0.417 | 0.750 |
| Tickets    | OpenSearch API path |      160 |    22.18 |    36.30 |       0.583 | 1.000 |
| Knowledge  | PostgreSQL FTS      |      160 |     3.66 |     6.90 |       0.292 | 0.750 |
| Knowledge  | OpenSearch API path |      160 |    12.83 |    23.49 |       0.417 | 1.000 |

PostgreSQL had lower p50 and p95 in both collections. OpenSearch recovered the intended results
for the two misspellings in each collection. For the other twelve inputs, both engines placed
the first relevant result at rank 1 and returned the same number of relevant hits in the top three.

| Collection | Input                | Caller and filter          | Labelled matches | PostgreSQL hits in top 3 | OpenSearch hits in top 3 |
| ---------- | -------------------- | -------------------------- | ---------------: | -----------------------: | -----------------------: |
| Tickets    | `VPN`                | Erin                       |                3 |                        3 |                        3 |
| Tickets    | `vnp`                | Erin                       |                3 |                        0 |                        3 |
| Tickets    | `pritner`            | Erin                       |                1 |                        0 |                        1 |
| Tickets    | `wired ethernet`     | Erin                       |                1 |                        1 |                        1 |
| Tickets    | `spreadsheet add-in` | Tara, open tickets         |                1 |                        1 |                        1 |
| Tickets    | `software licence`   | Tara, Network team         |                1 |                        1 |                        1 |
| Tickets    | `relaycase`          | Tom                        |                3 |                        3 |                        3 |
| Tickets    | `monitor flickers`   | Omar                       |                1 |                        1 |                        1 |
| Knowledge  | `VPN`                | Erin                       |                2 |                        2 |                        2 |
| Knowledge  | `vnp`                | Erin                       |                2 |                        0 |                        2 |
| Knowledge  | `pritner`            | Erin                       |                1 |                        0 |                        1 |
| Knowledge  | `wired ethernet`     | Omar                       |                1 |                        1 |                        1 |
| Knowledge  | `relaycase`          | Tara, Network/VPN category |                1 |                        1 |                        1 |
| Knowledge  | `password reset`     | Erin                       |                1 |                        1 |                        1 |
| Knowledge  | `software licence`   | Tom                        |                1 |                        1 |                        1 |
| Knowledge  | `wireless waking`    | Admin                      |                1 |                        1 |                        1 |

The backfill built and activated both indexes in 4.11 seconds. With the benchmark’s 1-second
worker poll, ticket visibility lag was 674 ms p50 and 1,377 ms p95. Article visibility lag was
945 ms p50 and 1,907 ms p95. Each p95 is the largest of 12 observations. The deployment default
worker poll is 5 seconds, so the measured lag applies to the benchmark configuration.

| Collection | PostgreSQL table and indexes | PostgreSQL FTS index (included at left) | Additional OpenSearch primary store |
| ---------- | ---------------------------: | --------------------------------------: | ----------------------------------: |
| Tickets    |                    1,560 KiB |                                 664 KiB |                           336.3 KiB |
| Knowledge  |                      320 KiB |                                 144 KiB |                            47.9 KiB |

The OpenSearch node used 4.87 seconds of process CPU during the timed retrieval run. Its used JVM
heap was 304 MiB at the start and 282 MiB at the end, with a 512 MiB heap maximum. After the run,
Docker reported 1.135 GiB memory for OpenSearch and 72.13 MiB for PostgreSQL. The snapshot covers
the entire containers. PostgreSQL remained active for the database-only comparator and the
OpenSearch API path.

These measurements describe one warm, sequential run with 16 hand-labelled inputs, synthetic
topic frequencies, and a single search node. The OpenSearch node stayed online while both API
paths ran on the same host. Production load, cold caches, larger corpora, multiple shards,
concurrent clients, and representative relevance labels would need separate measurements.
OpenSearch remains optional for the PostgreSQL-first MVP.

## Reproduction

Run the benchmark from the repository root against its own disposable Compose project. The
database and search node start empty. The benchmark command seeds synthetic data and creates an
index generation. Use a fresh project for each run.

```bash
project=smartdesk-search-evaluation
compose() { docker compose -p "$project" --profile ci --profile search "$@"; }
compose up --wait --wait-timeout 180 postgres-ci opensearch
compose build backend-ci
compose exec -T postgres-ci createdb -U ci smartdesk_search_benchmark_test
test_db=postgres://ci:ci-only-password@postgres-ci:5432/smartdesk_search_benchmark_test
compose run --rm --no-deps -w /app/backend \
  -e DATABASE_URL="$test_db" -e TEST_DATABASE_URL="$test_db" \
  -e TEST_OPENSEARCH_URL=http://opensearch:9200/ \
  -e SEARCH_BENCHMARK_REVISION="$(git rev-parse HEAD)" \
  backend-ci sh -c 'npm run migrate && npm run bench:search'
docker stats --no-stream "${project}-postgres-ci-1" "${project}-opensearch-1"
compose down -v
```

The JSON report includes the tested SHA, versions, corpus counts, every labelled query, top IDs,
per-query and pooled latency percentiles, and visibility and resource measurements. Set
`SEARCH_BENCHMARK_ROUNDS` in the benchmark container to change the default of 20 measured rounds.

## Corpus and method

The checked-in [corpus and relevance labels](../backend/test/fixtures/searchEvaluation.ts) extend
the normal test fixture with similar network and hardware tickets, a ticket in an inactive team,
and a draft article that matches a published topic. The base fixture supplies assigned,
reassigned, and reopened tickets. The benchmark adds 2,500 tickets and 500 articles across eight
background topics. Ranking labels come from the query intent and caller visibility. The set
includes `vnp` and `pritner` to measure common transpositions.

The benchmark sends the same authenticated ticket and knowledge API requests to two in-process
Fastify apps backed by the same PostgreSQL instance. One app enables OpenSearch and one uses
PostgreSQL full-text search. OpenSearch measurements include the application’s PostgreSQL
authorization, lag checks, hit verification, and hydration. After three warm-up rounds, the
benchmark sends requests sequentially and alternates the engine order. Latency spans Fastify
injection through response serialization, including database and index round trips. It excludes
browser and client-to-API network time. Each query retrieves up to three results. Precision@3
divides relevant IDs by three, including empty slots. MRR@3 gives each query the reciprocal rank of
its first relevant result, or zero when it has none. The report averages query scores equally and
uses nearest-rank latency percentiles.

For visibility lag, the benchmark creates tickets and publishes draft articles through their
normal write services. It measures from the committed write returning to the new ID appearing
through the OpenSearch read alias. It uses 12 samples per collection, a 1,000 ms worker poll
interval, and a 50 ms observation interval, with normal index refresh. PostgreSQL and OpenSearch
storage figures are captured before the visibility probes. OpenSearch process CPU is the change
in cumulative CPU time across the paired latency run, and its heap figures are point samples.

## Authorization and lifecycle checks

The same `relaycase` query, paged one result at a time, exercises both engine modes. The coverage
includes the intermediate cursor and the terminal page so a denied match cannot create another
page.

| Caller                                    | Network ticket | Hardware ticket | Unassigned ticket | Inactive-team ticket |
| ----------------------------------------- | -------------- | --------------- | ----------------- | -------------------- |
| Erin (employee, network ticket owner)     | Yes            |                 |                   |                      |
| Omar (employee, other three ticket owner) |                | Yes             | Yes               | Yes                  |
| Tara (Network technician)                 | Yes            |                 | Yes               |                      |
| Hana (Hardware technician)                |                | Yes             | Yes               |                      |
| Tom (Network and Hardware technician)     | Yes            | Yes             | Yes               |                      |
| Admin                                     | Yes            | Yes             | Yes               | Yes                  |
| Inactive employee or technician           | 401            | 401             | 401               | 401                  |

The [authorization integration suite](../backend/test/integration/searchEvaluation.integration.test.ts)
checks that ticket responses contain authorized summaries and cursors, with no raw content,
counts, facets, or highlights. An unauthorized tracking ID returns the same data as an unknown
one. A category filter on knowledge search excludes drafts from both items and totals for
employees, technicians, and admins using the reader API. In the live race tests, OpenSearch
returns a candidate, then a committed membership removal, ticket reassignment, or article
unpublication happens before PostgreSQL hydration. The results and totals exclude the revoked
rows. The reassigned ticket is searchable for the recipient team via PostgreSQL while indexing
is pending.

The [index worker tests](../backend/test/integration/searchIndexOpenSearch.integration.test.ts)
cover duplicate delivery, out-of-order writes, and tombstones.
The [rebuild tests](../backend/test/integration/searchRebuildOpenSearch.integration.test.ts)
cover resumable backfill, replay behind the scan cursor, and verification before alias cutover.
The [browser verification](../docker/verify-ticket-search-browser.sh) runs ticket search with the
index live, then stops the node and verifies scoped fallback, exact lookup, and ordinary list and
detail. The default PostgreSQL-only test job runs the same role matrix and the existing fallback
and knowledge tests without starting OpenSearch.
