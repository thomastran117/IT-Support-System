# Architecture

SmartDesk is a small service-oriented application packaged as one Docker Compose project.

The [incremental service extraction ADR](architecture/microservices-adr.md) describes the optional
post-MVP migration and its cutover gates.

## Runtime services

```text
Browser -> frontend (Next.js)
Browser -> gateway (Fastify) -> backend (Fastify) -> PostgreSQL <- worker
```

- **Frontend** renders the employee, technician, and administrator portals. The browser calls the
  API at `NEXT_PUBLIC_API_URL`; the frontend does not connect to PostgreSQL.
- **Gateway** owns the public API listener and forwards requests to the backend.
- **Backend** owns HTTP authentication, authorization, validation, ticket workflows, database
  migrations, and seed/documentation commands.
- **Worker** is the host for asynchronous work: the Compose `worker` service runs the backend's
  `src/worker.ts` entrypoint (see Analysis queue and worker). It remains functional when the
  optional AI provider is disabled.
- **PostgreSQL** is reachable only on Compose's internal network. Only the frontend and gateway
  publish host ports.
- **Redis** is an optional, internal-only cache with no persistence, disabled unless the `cache`
  (dev) or `ci` profile starts it; PostgreSQL remains the authoritative store regardless.

## API gateway

The gateway forwards `/api`, `/api/*`, `/health/live` and `/health/ready` over the private
Compose `api` network. The backend listens on its `backend-api` address on that network. The
browser continues to use the same API base URL, origin rules, refresh-cookie path and rotation,
and response envelopes. The gateway forwards authorization, cookies, idempotency keys, and
retry headers. It passes through backend status, body, and individual `Set-Cookie` headers.
Requests use the caller's `X-Request-Id` or a generated one across both hops.

`GATEWAY_UPSTREAM_TIMEOUT_MS` defaults to 10000. The gateway makes one upstream attempt per
request and returns an API error envelope with 503 when the backend is unreachable or the
deadline expires before headers are received. A broken upstream connection before headers
returns 502. A deadline during streaming closes the interrupted response. Backend health
responses retain their original formats. [API reference](api.md)

The gateway replaces incoming forwarding headers with the client IP that Fastify resolved.
`TRUST_PROXY` defaults to false at the public listener. If that listener sits behind a known
reverse proxy, configure its trusted IPs or CIDRs. The backend trusts the gateway-supplied IP on
the private listener so IP-based login and refresh limits continue to work. The direct API
override applies `TRUST_PROXY` to the backend's public listener instead.
[Direct API rollback](../README.md#switch-back-to-the-direct-api)

Internal endpoints authenticate a scoped service credential at the receiving backend. Delegated
calls also verify the current user and resource scope.
[Internal service authentication](authentication.md#internal-service-authentication)

In Notifications service mode, only the inbox route and its subpaths target the independent
Notifications listener. Ticket requests and gateway readiness use the backend. [Notifications service](architecture/notifications-service.md)

## AI service container

`backend/services/ai` is the first package under `backend/services/`. Its Compose profile
`services` builds a separate image and starts the compiled Fastify server. Its private `api`
connection reaches Ticket directly. The `ai-egress` network gives the selected provider outbound
access. The AI container uses HTTP for job and input access and has no database connection.
The public gateway forwards only its existing API and health paths.

| Setting                                          | Default                              | Purpose                                                                     |
| ------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------- |
| `AI_SERVICE_TICKET_ORIGIN`                       | `http://backend-api:4000` in Compose | Private Ticket origin. Use HTTPS in production.                             |
| `AI_SERVICE_READY_TIMEOUT_MS`                    | `1500`                               | Full readiness probe deadline, from 1 through 5000 milliseconds             |
| `HOST` and `PORT`                                | `0.0.0.0:4010` in Compose            | Container listener on the internal network                                  |
| `AI_EXECUTION_MODE`                              | `local`                              | `service` starts independent execution and pauses the legacy analysis loop. |
| `AI_SERVICE_KEY_ID` and `AI_SERVICE_PRIVATE_KEY` | Empty                                | Caller key ID and P-256 PKCS#8 signing key for active independent analysis. |
| `AI_SERVICE_API_KEY`                             | Empty                                | OpenAI credential delivered to the independent container as `AI_API_KEY`.   |

- `GET /health/live` returns `200` with `{"status":"ok"}` when the process can answer HTTP.
- `GET /health/ready` reports `checks.ticketApi` as `ok` once the existing Ticket API reports a
  healthy database. Connection failures, timeouts, and non-ready responses return `503` with
  `checks.ticketApi` set to `unavailable`. The next probe can pick up recovery.

Compose uses Ticket readiness as the container healthcheck. The lifecycle check exercises
dependency loss and recovery, then restarts the independent runner after it saves a proposal
using the fake provider. [Compose lifecycle check](../docker/verify-service-containers.sh)

### AI service cutover and rollback

Provision the AI service with a P-256 private key and set `AI_SERVICE_KEY_ID`. Add its matching
public key to Ticket's `INTERNAL_SERVICE_KEYS` registry with `service` set to `ai`. Give it
the four system scopes `ticket:analysis-claim`, `ticket:analysis-inputs`,
`ticket:analysis-complete`, and `ticket:analysis-fail`. The service signs a short-lived token
for each call. Keep the private key and any live provider credential with the AI service only
during this mode. [Internal service authentication](authentication.md#configure-and-rotate-keys)

Set `AI_EXECUTION_MODE=service` with `AI_PROVIDER=fake` for the first cutover. Stop the legacy
worker so it can drain its active jobs, then recreate Ticket and the worker in service mode.
Start the independent container after Ticket is ready. The worker can continue its email and
search loops. To use OpenAI, set `AI_PROVIDER=openai` and supply `AI_SERVICE_API_KEY`.

```bash
docker compose stop -t 90 worker
docker compose up -d --build backend worker gateway
docker compose --profile services up -d --build --wait ai-service
```

Ticket owns the queue and serves four scoped commands under `/internal/tickets/analysis-jobs`.
A claim rotates the existing lease token. The input command verifies the job, request, ticket,
token, and expiry before and after reading from Ticket and the published Knowledge adapter.
It sends redacted, bounded text and current allowlists. The AI runtime validates proposals
against those inputs. Ticket rechecks current references when saving a proposal.

Completion marks the job complete, saves the immutable proposal and article links, and publishes
`recommendation.ready` in one transaction. A loss of the acknowledgement can be retried with the
same command. A matching completed job acknowledges the existing recommendation. An expired or
replaced lease cannot change a job or apply a draft. Failure reports carry only a reason code.
Ticket decides retryability and delays. An abandoned lease expires and becomes eligible for
another claim, or reaches `FAILED` once attempts are exhausted. Ticket creation, manual routing,
and review use their existing endpoints during an AI outage. A new lease can repeat the provider
call after a crash. The job still commits a single recommendation.

For rollback, stop the independent runner and allow it to drain, or let its active leases
expire. Set `AI_EXECUTION_MODE=local` and restore the existing `AI_API_KEY` to the legacy
worker if using OpenAI. Recreate Ticket and the worker. Both runners use the same jobs,
attempt counts, and saved recommendations.

```bash
docker compose --profile services stop -t 90 ai-service
docker compose up -d --build backend worker gateway
```

For a package-local build from a checkout, install and build the shared packages, then install
and start the service.

```bash
npm --prefix packages/contracts ci
npm --prefix packages/contracts run build
npm --prefix packages/service-runtime ci
npm --prefix packages/service-runtime run build
npm --prefix packages/ai-analysis ci
npm --prefix packages/ai-analysis run build
npm --prefix backend/services/ai ci
npm --prefix backend/services/ai test
npm --prefix backend/services/ai run build
npm --prefix backend/services/ai start
```

Outside Compose, the listener defaults to `127.0.0.1:4010`. Set the Ticket origin to the
backend listener for scoped commands. [Compose start commands](../README.md#opt-in-ai-service-container)

## Package boundaries

Every package is independently locked and installed in its container image.

- `packages/contracts` contains browser-safe TypeScript types, constants, and Zod schemas. It must
  not import Node-only, Fastify, PostgreSQL, or Prisma code.
- `packages/db` exports the generated Prisma client and PostgreSQL adapter used by the backend and
  worker. Prisma generates its client from `backend/prisma/schema.prisma` during image builds.
- `packages/service-runtime` contains server-side environment parsing used by the gateway and AI
  service. Both install it as an explicit local dependency.
- `packages/ai-analysis` contains shared provider adapters, prompt construction, validation, and
  runner logic for the independent AI service and the legacy worker.
- Applications that share packages use local `file:` references. Docker builds contracts,
  generates Prisma, and builds the database package before starting a consumer.

There is intentionally no root npm workspace. Cross-package ordering belongs to the Docker build
and verification scripts in `docker/`.

## OpenSearch indexes and aliases

The server-only client queries read aliases and returns candidate IDs, with sort values and source
revisions when requested.
Callers must reload candidates from PostgreSQL and enforce current access and publication rules
before returning results. Search requests use a 750 ms timeout per attempt and at most one retry
for transient failures. The circuit opens for 10 seconds after three consecutive operations fail
with transient errors. A single probe then determines whether it can close. API startup is independent
of OpenSearch.

| Projection | Initial index            | Read alias                 | Write alias                 |
| ---------- | ------------------------ | -------------------------- | --------------------------- |
| Tickets    | `smartdesk-tickets-v1`   | `smartdesk-tickets-read`   | `smartdesk-tickets-write`   |
| Knowledge  | `smartdesk-knowledge-v1` | `smartdesk-knowledge-read` | `smartdesk-knowledge-write` |

Both mappings reject unknown fields. Ticket UUIDs, status, and priority use exact keyword fields.
Ticket titles and descriptions use the standard text analyzer. Creation and update dates use ISO
timestamps, and the source version is a long integer. Knowledge uses an exact article and category
ID, analyzed title and body, publication state, and source version. Its read alias filters for
published articles. Internal comments, audit data, recommendations, model prompts, and credentials
are outside both projections.

On a secured deployment, use separate service roles scoped to these projections. The API role
gets search access through the read aliases. The worker gets writes through the write aliases
and needs search access to the knowledge read alias when AI analysis is enabled. The provisioning
role gets index creation and alias inspection. Run `npm run search:init` with provisioning credentials
once per new cluster. It creates each index and its aliases atomically. Check the alias layout
before resolving an initializer conflict. Use production certificates and service credentials from
the deployment secret store. OpenSearch connectivity is private to the server side.

### Ticket search authorization

The ticket search service takes an authenticated principal. Its OpenSearch query limits employees
to their own tickets and technicians to their own tickets, their active teams, and the unrouted
backlog. Technicians need at least one active team membership for backlog access. Admins can search
all tickets. Status, priority, category, team, assignee, and creation dates can narrow that scope.
Creation date ranges include the lower bound and exclude the upper bound.

After OpenSearch returns, one PostgreSQL snapshot rechecks the account and team membership and
bulk-loads tickets that still satisfy the shared ticket read policy and all structured filters.
Each candidate's indexed revision must match the ticket's current version. Results contain
PostgreSQL ticket summaries and an optional server-side cursor. Index documents, highlights,
hit totals, facets, and suggestions are discarded by the search client.

Candidates are ordered by relevance and then ticket ID. A search reads up to three candidate
pages of at most 100 hits each. The cursor points to the last returned ticket and is issued only
when another authorized match was found. Stale or denied candidates can exhaust the scan budget,
and index refreshes can change ranking between requests. The search client requests only the
candidate ID, sort values, and indexed revision. [OpenSearch search API](https://docs.opensearch.org/latest/api-reference/search-apis/search/) · [OpenSearch pagination](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/)

The authenticated ticket search route uses a rate limit keyed by account. Its text path encrypts
the continuation with a key derived from the server secret, the caller's scope, and the normalized
query. Exact tracking ID lookups go directly to PostgreSQL and apply the same read policy and
structured filters. See [ticket search API](api.md#ticket-search).

### PostgreSQL ticket search and index lag

When OpenSearch is disabled or returns a timeout, circuit-open response, or other search error,
ticket text search uses PostgreSQL. The fallback uses a bound `plainto_tsquery` and the weighted
`idx_tickets_fts` GIN expression from migration `0014`. The indexed fields are the ticket title and
description. The SQL applies the shared requester and active-team scope plus the same structured
filters before ranking. It reads the principal, ranked IDs, and summaries in one PostgreSQL
snapshot. [PostgreSQL text search indexes](https://www.postgresql.org/docs/16/textsearch-tables.html)

Before calling OpenSearch, a scoped `EXISTS` query checks the outbox for current ticket revisions
that match PostgreSQL text and structured filters. A queued, running, or failed matching revision
uses PostgreSQL. The same rule applies for two seconds after a matching job completes to cover
refresh lag. This makes committed new and reassigned tickets searchable by their current terms
while the worker catches up, and keeps lag in other users' tickets out of the decision. Exact UUID
lookups and ordinary list, detail, and queue requests always read PostgreSQL.

Text pages omit totals and expose a cursor only when another authorized result was found. PostgreSQL
fetches one extra matching row and uses rank plus ticket ID as its cursor. OpenSearch needs a bounded
candidate scan and can return a short page. The engines use different ranking and matching rules,
so a cursor stays with its engine. Authorized edits can shift either engine's results between pages.

Monitor oldest outstanding age and failed jobs in the outbox, alongside the backend log
`Ticket search using PostgreSQL` grouped by `reason`. A rising queued or running age indicates
backlog growth. Inspect worker health, alias availability, and failed job reason codes when age or
fallback frequency rises. This operational query groups jobs without ticket text or IDs.

```sql
SELECT entity_type, state, count(*) AS jobs,
       max(statement_timestamp() - created_at) AS oldest_age
FROM search_index_jobs
WHERE state IN ('QUEUED', 'RUNNING', 'FAILED')
GROUP BY entity_type, state;
```

### Published knowledge search

The knowledge endpoint calls `createPublishedKnowledgeSearch`. For plain text, the OpenSearch
adapter filters by publication and optional category and ranks title and body matches with BM25.
It reads candidate IDs, revisions, and sort positions in relevance and article ID order.
One PostgreSQL statement then selects current published candidates in the requested category and
builds their previews. Only matching revisions contribute to the result order, count, and page.
[OpenSearch multi-match](https://docs.opensearch.org/latest/query-dsl/full-text/multi-match/) · [OpenSearch pagination](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/)

Search reads batches of up to 100 candidates and checks whether it can verify the full result set
within a 300-candidate budget. For larger or incomplete scans, OpenSearch failures, and queries
using PostgreSQL web search operators, the existing published-only PostgreSQL FTS query builds
the page and total. See [knowledge search API](api.md#search).

### Search indexing worker

With `OPENSEARCH_ENABLED=true`, the backend worker claims up to 25 outbox jobs at a time with
`FOR UPDATE SKIP LOCKED` and a 30-second lease. It reloads current ticket and article rows in
PostgreSQL, writes one document per entity in the batch through the write aliases, and settles
each job with its lease token. API writes and outbox commits run independently of this loop.

An OpenSearch document's external version is twice the PostgreSQL source revision. A removal uses
the next odd version and replaces the document with a content-free tombstone. The ticket adapter
requires a status field and the knowledge read alias requires publication, so both search paths
exclude tombstones. Strict external versioning makes older and duplicate writes harmless even after
a long delay. Rebuilds must use the same version encoding. Bulk search writes require aliases and
use a 5-second request timeout. [OpenSearch Bulk API](https://docs.opensearch.org/latest/api-reference/document-apis/bulk/)

Transient failures retry with exponential backoff and jitter. Missing aliases retry within the
same attempt budget. Permanent rejections and exhausted jobs become `FAILED` with a reason code.
The worker drains its active batch on SIGTERM. An interrupted batch becomes claimable after its
lease expires. To retry a failed job after resolving its cause, pass the job ID:

```bash
docker compose exec worker npm run search:requeue -- <failed-job-id>
```

### Search backfill and reindex

Use `npm run search:backfill -- --version 1` for an empty OpenSearch cluster. On an installation
that already uses v1, use `npm run search:reindex -- --version 2`. Both commands use the same
rebuild workflow with PostgreSQL migrations applied and the OpenSearch provisioning credentials.
Supply `--dry-run` to read the active generation, checkpoint phase, and source counts without
changing PostgreSQL or OpenSearch. Rerun with the same version to resume an interrupted build.

The command creates a replacement ticket and knowledge index with the current mappings and scans
tickets and published articles in batches of 25 using their IDs as cursors. PostgreSQL stores the
checkpoint and each replacement index carries its matching build ID. Replaying a batch uses the
same projections, external versions, and tombstones as the worker.

The replay watermark is the highest outbox sequence visible while holding a PostgreSQL table lock
that waits for inserts to commit or roll back. The replay includes earlier outbox rows so removals
survive the rebuild. A large tail is replayed in bounded batches while source writes continue.
During the final handoff, the command briefly locks source writes, applies the remaining changes,
refreshes the replacement indexes, and checks live document counts against PostgreSQL. It moves
all four aliases in a single request and retains the previous generation. [PostgreSQL locks](https://www.postgresql.org/docs/16/sql-lock.html) · [OpenSearch aliases](https://docs.opensearch.org/latest/api-reference/alias/aliases-api/)

If the command exits during `CUTOVER`, rerun the same version before starting a different handoff.
The worker pauses new claims in that phase, while incoming edits continue to queue in PostgreSQL.
On resume, the rebuild replays those edits and checks where the aliases point before releasing
claims. A failed verification before cutover leaves the live aliases and worker active. For a
rollback, retain the earlier generation and use its mapping for a new verified rebuild so the
replacement includes current edits.

Run the search integration tests against a disposable Compose project with empty indexes:

```bash
docker compose -p smartdesk-search-test --profile ci --profile search up --wait postgres-ci opensearch
docker compose -p smartdesk-search-test --profile ci build backend-ci
docker compose -p smartdesk-search-test --profile ci --profile search run --rm --no-deps \
  -e TEST_OPENSEARCH_URL=http://opensearch:9200/ -w /app/backend backend-ci \
  sh -c 'npm run migrate && ./node_modules/.bin/vitest run --no-file-parallelism test/integration/openSearch.integration.test.ts test/integration/searchIndexOpenSearch.integration.test.ts test/integration/searchRebuildOpenSearch.integration.test.ts test/integration/ticketSearch.integration.test.ts test/integration/ticketSearchApi.integration.test.ts test/integration/knowledgeOpenSearch.integration.test.ts'
docker compose -p smartdesk-search-test --profile ci --profile search down -v
```

## Request and data flow

All API responses use the envelope `{ message, error, details, data }` and include an
`X-Request-Id`. The backend validates untrusted input at the route boundary and obtains identity
from the access token rather than request bodies. Database changes that span records use Prisma
transactions; append-only comments and events are additionally protected by database triggers.

The frontend holds the access token in memory. Its API client performs at most one shared refresh
and one retry after a 401. Route guards improve navigation, but the backend independently authorizes
every request.

## Caching

`backend/src/cache/cacheAside.ts` implements a generic cache-aside accessor over the shared Redis
client (`backend/src/cache/client.ts`). Each accessor is bound to one namespace (e.g. `ref:teams`)
and TTL; keys embed the namespace's current generation number (`smartdesk:<namespace>:v<n>:<key>`).
Invalidating a namespace bumps that generation rather than deleting keys, so a slow write that is
still in flight when a newer write invalidates the namespace writes into the now-orphaned old
generation instead of clobbering the live one -- no distributed lock is needed for this guarantee.

Any Redis failure -- resolving the generation, reading, or writing -- falls straight through to the
caller's `fetch`, so PostgreSQL remains authoritative and Redis is never load-bearing for
correctness; this also holds when Redis is disabled entirely (the no-op client makes every read a
miss). Call `invalidate()` only after the write that changed the underlying data has committed,
never from inside the transaction and never on a rollback.

Ticket detail, tokens, and permission decisions are never cached by default -- only non-sensitive,
low-churn reference data is a candidate, and a private/role-scoped read is cached only when scoped
by authorization or not cached at all.

**What is actually cached today:**

- `backend/src/modules/teams/service.ts`'s `listActiveTeams`, `listActiveCategories`, and
  `listAssignableMembers` (staff-only reference reads under `/api/teams` and `/api/categories`),
  60s TTL. Every team/category write (`backend/src/modules/teams/{service,categoryService}.ts`)
  invalidates the relevant namespace once its transaction has committed. Note that
  `listActiveCategories` reads the `ref:categories` namespace that `categoryService.ts`'s writes
  invalidate -- a pre-existing cross-file split in who lists categories versus who administers
  them, not something this epic introduced.
- `backend/src/modules/reports/routes.ts`'s admin report aggregates (Q05-Q14), keyed by
  `<query>:<window start>_<window end>`, 30s TTL, **no active invalidation** -- these are
  analytical reads where brief staleness is an accepted tradeoff, and wiring invalidation into
  every ticket/event/recommendation write path across the app would be a large, cross-cutting
  change for limited benefit versus a short TTL. Cardinality is bounded by that same short TTL
  plus the existing `REPORT_MAX_WINDOW_DAYS` cap, not by rounding the caller's chosen window --
  rounding would risk returning a _different_ window's data than the one actually requested.
  `Cache-Control: no-store` on these responses is unrelated and unchanged: it governs browser/CDN
  caching of the HTTP response, not this server-side cache of the underlying query.

**Authorization and caching for the reports route specifically:** `requireRole('ADMIN')` is the
route's `preHandler` and re-reads the caller from the database on _every_ request, cache hit or
miss, so a cache entry is never itself the authorization boundary -- caching wraps only the
per-query result underneath an already-authorized request. Each report function
(`backend/src/db/repositories/reports.ts`) also re-authorizes internally; that check still fully
protects any other, future caller of those functions that does not go through this route's guard,
and simply does not re-run on a request this route has already authorized moments earlier.

**Single-flight fills and stampede protection (SD-072):** `createCacheAside`'s `read()` dedupes
concurrent misses for the same `(namespace, keySuffix)` at two levels so a cold or just-invalidated
key never turns into N parallel PostgreSQL queries:

- **Per-process:** a `Map<string, Promise>` inside the accessor's closure. Every concurrent caller
  in this process for the same key awaits the one in-flight `fetch`, rather than each starting its
  own.
- **Cross-process:** before calling `fetch`, the first instance to arrive acquires a short lease
  (`setIfAbsent`, default 5s TTL) keyed on `smartdesk:lock:<namespace>:<keySuffix>`. Any other
  instance that loses the race polls `get(key)` with the same jittered backoff used for Redis
  reconnects (`jitteredBackoff`, see `redisCache.ts`), bounded by a default 2s wait, and serves the
  lock holder's result as soon as it lands. The lease is released (CAS, via `releaseIfOwner`) once
  the holder's `fetch` settles, and a holder that crashes mid-fill self-heals purely through the
  lease's own TTL expiry -- no explicit crash detection is needed.
- **Bounded waiting, always:** a waiter that outlasts the 2s bound falls through to its own direct,
  uncached `fetch` rather than blocking any longer. This is deliberate: a manual ticket action must
  never be stuck behind another request's cache fill, even during contention. Both bounds
  (`lockTtlMs`, `maxWaitMs`) are constructor options for tests; every production call site uses the
  defaults.

This only bounds request _fan-out_ against PostgreSQL for the same key; it changes nothing about
what gets cached, for how long, or when it is invalidated, and Redis remains non-load-bearing for
correctness exactly as described above -- a lock acquisition failure (Redis down) is treated the
same as contention and falls through to a direct fetch.

## Rate limiting

Login, refresh, and triggering AI analysis (`POST /tickets/:id/analysis`) are rate-limited via
`@fastify/rate-limit`. When Redis is configured, `backend/src/rateLimit/fallbackStore.ts` backs the
limiter with a shared counter in Redis, so every backend instance enforces one combined quota
instead of one quota per process; when it is not, the plugin's own in-memory store is used exactly
as before this epic. A request is always keyed by the authenticated account id once one exists
(the AI-trigger route), or by the client IP otherwise (login, refresh) -- never by a raw header a
client could forge.

On a Redis failure, the limiter does not fail open: it falls back to a bounded per-process counter
rather than the plugin's own `skipOnError` (which would let every request through unlimited). This
is a deliberately different failure mode from caching above -- rate limiting is security-sensitive,
so an outage degrades to a conservative local bound instead of no limit at all.

The public listener resolves `request.ip` using Fastify's `trustProxy` setting (`TRUST_PROXY`).
The default `false` uses the socket peer. In gateway mode the backend receives that resolved IP
over the private listener. See [API gateway](#api-gateway).

**Outage, concurrency and performance evaluation (SD-073):** see
[`docs/redis-evaluation.md`](redis-evaluation.md) for a reproducible benchmark (baseline vs cached
reads, cross-instance rate-limit sharing, degraded-mode behavior) and the correctness checks that
ticket/audit data and the degraded rate-limit mode behave as specified while Redis is unreachable.

## Technician screens

`/technician` is the triage dashboard: tabs for the unassigned backlog, a team queue and tickets
assigned to the technician, with priority and category filters, urgency chips, age and pagination
(`GET /api/technician/queue`, `/unassigned`). `/technician/tickets/:id` is the triage detail. The
approved category, priority, team and assignee are edited in one form and saved with
`POST /api/tickets/:id/routing`; status buttons mirror the backend workflow, and resolving needs a
summary. Internal notes are visibly distinct and are never returned to the requester. Every write
sends the ticket `version`: on a `VERSION_CONFLICT` the page reloads the latest ticket and says so
instead of overwriting. If a change hands a ticket to a team the technician does not belong to, the
page explains that it can no longer be opened. Manual triage never depends on AI: the AI suggestions
card loads separately, and if it fails the rest of the page still works. The card is labelled "AI
suggestion — requires review", shows the original proposal beside the currently approved values, and
offers accept, override (with the technician's own values) and reject, each sent against the ticket
`version` through `POST .../recommendations/:id/review`. Suggestions whose category or team is no
longer active cannot be accepted, and resolved or closed tickets can only reject. Earlier suggestions
and their decisions stay visible under "Earlier suggestions".

The same card drives the analysis job (SD-038) through `GET` and `POST /api/tickets/:id/analysis`. It
shows queued, running, retrying (with the reason, attempt and retry time), failed (with the fixed
reason text and number of tries) and "AI analysis is switched off". A "Request analysis" button
(labelled "Re-analyse" once a suggestion exists, "Try analysis again" after a failure) sends one request
at a time, with a client-generated request id so a repeated submit is idempotent; the server's 409 (one
already running), 429 (hourly limit) and AI-disabled answers are explained in place and the status
refreshes. While a job is queued or running the page checks every 2 seconds and loads the new
suggestion by itself when it completes. A new analysis only adds a separate suggestion: approved
routing changes only through a review or the routing form. A deterministic, keyword-based "looks high
risk" cue is shown whenever it applies and is labelled as not AI. If the status cannot be loaded the
card says so with a "Check again" button, and the routing form is never disabled by any AI state.

## AI provider

`packages/ai-analysis` defines the advisory AI boundary. `AIProvider.analyse()` takes redacted ticket text, active category and team allowlists, and retrieved knowledge articles. It returns a `ValidatedProposal` or throws a classified `ProviderError`. Timeout, rate limiting, and provider unavailability are retryable.

- `AI_PROVIDER` selects `none` (default), `fake` (deterministic, used by CI), or `openai`. `AI_MODEL`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, and `AI_MAX_INPUT_CHARS` configure the live adapter. The process running the adapter sends its provider key only in the provider's `Authorization` header.
- Model output must match a strict Zod schema (category/team UUIDs, priority `LOW|MEDIUM|HIGH|CRITICAL`, bounded troubleshooting text, optional 0..1 `confidence`, optional cited article IDs). Category, team and article IDs are then checked against the allowlists supplied for that request; hallucinated values are rejected, not repaired.
- `confidence` is the model's self-reported score and is not a calibrated probability. A proposal is a draft: this module never changes a ticket.

### Ticket analysis (SD-034)

`createAnalysisService({prisma, provider, searchClient}).analyse(ticketId)` in `analysisService.ts`
returns an `AnalysisDraft` with the validated proposal, ranked retrieved article IDs, and retrieval
metadata. The job runner persists the recommendation when it completes the job.

1. Loads the ticket title and description and the **active** categories and teams.
2. Extracts up to 12 distinct terms from the redacted ticket and calls the shared published search
   adapter for up to five articles. OpenSearch has a total 1.5-second budget across its requests and
   retries. PostgreSQL FTS matches any of the same terms when OpenSearch is disabled or cannot
   complete the search within its limits.
3. Reloads published article bodies from PostgreSQL and keeps candidates at the verified revision.
   The provider receives the redacted and truncated ticket title and description, the allowlists,
   and current article text.
4. Checks the provider's proposed category, team and cited article IDs against what was sent.
   Cited articles follow retrieval order.

Ticket text and article text are untrusted: the prompt serialises them as one JSON document and tells the model to treat them as data. The real defence is structural, since output that is not a valid, allowlisted proposal is rejected and nothing else is acted on.

**Redaction limits.** `redact.ts` is pattern based. It removes emails, credentials in URLs, bearer/JWT/API-key style tokens, `password: ...` style assignments, long hex/base64 strings, card-like and SSN-like numbers and private-key blocks. It cannot recognise names, addresses, free-form passphrases or secrets written in prose, so users should not paste credentials into tickets. Retrieval query text is redacted too, and nothing in this module logs ticket or article text.

### Analysis queue and worker (SD-035)

Analysis never runs inside the ticket request. When `AI_PROVIDER` is not `none`, `POST /api/tickets` inserts a row into `ai_analysis_jobs` **in the same transaction as the ticket**, so a job exists if and only if the ticket does and dispatch cannot be lost between commit and queueing. The response returns 201 without calling the provider. An idempotent replay of a submission queues nothing new.

In local mode, the analysis runner starts in the backend worker entrypoint (`src/worker.ts`,
`npm run start:worker`, Compose service `worker`). In service mode, the independent runner uses
the same queue through authenticated Ticket commands.

- **Claiming:** `FOR UPDATE SKIP LOCKED` with a lease and a rotating `lease_token`. Several workers can run at once and never take the same job. `AI_WORKER_CONCURRENCY` caps parallel analyses per process.
- **Idempotency:** `(ticket_id, request_id)` is unique, so enqueueing the same request twice gives one job; a re-analysis uses a new request id.
- **Retries:** each claim counts as an attempt (`AI_JOB_MAX_ATTEMPTS`, default 3). Retryable failures (`timeout`, `rate_limited`, `unavailable`, unexpected errors) go back to `QUEUED` after `AI_JOB_BACKOFF_MS * 2^(attempt-1)`, capped at 15 minutes. Non-retryable ones (`malformed`, `invalid_reference`, `disabled`, `ticket_missing`) and exhausted jobs become `FAILED` with an `error_kind` reason code, never message text.
- **Crash recovery:** a worker that dies leaves a `RUNNING` row whose lease expires; another worker re-claims it. A job that keeps killing its worker ends as `FAILED(worker_lost)`.
- **Exactly-once effect:** completing a job, and any write that must happen once (the recommendation, SD-036), run in one transaction guarded by the lease token. A stale worker that finishes late finds its token gone and its result is discarded, so duplicate delivery cannot create a second result.
- **Shutdown:** on SIGTERM the worker stops claiming and lets in-flight analyses finish (bounded by their timeout); anything unfinished is retried via lease expiry.
- **Logging:** structured lines include job, ticket and request IDs, attempt, state and reason code.
  The analysis result log includes `retrieval.engine` (`opensearch`, `postgres`, or `none` when
  there are no search terms) and `retrieval.version` (the retrieval policy version). Search terms,
  article text and prompts stay out of logs.

### Recommendation persistence (SD-036)

`persistRecommendation` (`recommendationService.ts`) runs in the Ticket transaction that
completes the job. Both execution modes use it to write one `ai_recommendations` row, its
`recommendation_articles` links, and the service outbox event.

- **One row per attempt:** `ai_recommendations.job_id` is unique, so retries and duplicate delivery produce exactly one recommendation and never re-link articles. Re-analysis is a new job and therefore a new row; earlier rows and their review decisions are kept. `job_id` is NULL for rows that did not come from a job (fixtures, history).
- **Atomic:** the row and its links commit together or not at all. Any validation or database error throws and rolls the whole graph back; the job is then retried as an ordinary failed attempt.
- **Validated when written:** active category and team, priority in `LOW|MEDIUM|HIGH|CRITICAL`, confidence within 0..1 (rounded to 3 decimals), non-empty troubleshooting text, and a model version of at most 100 characters. Sources must exist, be published and not repeat; ranks are 1..n in retrieval order.
- **Model metadata:** `model_version` is `<provider>:<model>@prompt-<version>` (for example `openai:gpt-4o-mini@prompt-v2`), so a recommendation can be traced to its prompt.
- **Immutable proposal:** review state starts `PENDING` and the ticket is not changed. The only later update path, `markReviewed`, writes review columns only; accept, override and reject leave every `proposed_*`, `suggestion`, `confidence` and `model_version` value, and the source links, as they were. This is enforced in the service, not by a database trigger.

### Failure handling and manual fallback (SD-037)

Manual work never depends on the AI path. Ticket creation does not call the provider, a failed or missing analysis leaves the ticket `OPEN`, and routing, transitions and review keep working whatever the job state.

- **States:** every failure ends as a reason code on the job (`unavailable`, `timeout`, `rate_limited`, `malformed`, `invalid_reference`, `ticket_missing`, `worker_lost`, `disabled`, `internal`). `GET /api/tickets/:id/analysis` maps these to client-safe reasons with fixed wording. Unknown codes degrade to `internal`, so nothing stored can leak through the mapping.
- **No infinite loops:** automatic retries are bounded (`AI_JOB_MAX_ATTEMPTS`) with exponential backoff. After that the job is `FAILED` and only an explicit technician request starts a new attempt.
- **Retry:** `POST /api/tickets/:id/analysis` creates a new job with its own request id; the failed one is left as it was. Concurrent or repeated requests are serialised by a per-ticket advisory lock, so one is accepted and the rest get `409`, and a per-ticket hourly cap returns `429`. When the provider recovers, the next request produces a normal recommendation.
- **No phantom results:** a failed attempt writes no recommendation and no ticket event.
- **Manual cue:** `riskCue.ts` flags tickets that read as high risk with plain keyword rules, so a technician is still nudged to prioritise by hand when AI is down. It is not stored, not applied and not presented as AI output.
- **Logs:** job logs carry ids, attempt, state and reason code only. Provider errors, keys and ticket text are never logged or stored.

### Evaluation (SD-039)

`backend/src/modules/ai/evaluation/` measures category accuracy on a version-controlled synthetic dataset with independent reference labels, using the same definition as SQL report Q07 (first valid prediction, missing or invalid counts as wrong, denominator is all labelled cases). `npm run eval:ai` runs it with a deterministic offline provider in CI, or optionally a real provider in a controlled environment, and writes a Markdown and JSON report with counts, a confusion matrix, failed cases, a 95% interval, and the prompt, model and dataset versions. The prompt text is pinned by hash per version. See [ai-evaluation.md](ai-evaluation.md) for the method, cost and exactly what can and cannot be claimed.

## Development and validation

`docker compose up --build --watch` synchronizes application source. Shared-package, manifest, and
Prisma changes trigger image rebuilds so consumers always use compiled package output.

Compose profiles add one-shot services without affecting the normal stack:

- `ci`: formatting, backend/database/worker verification, and browser-enabled frontend tests.
- `tools`: generated documentation commands whose output is mounted back into the repository.
- `cache`: an optional internal Redis instance for local cache development; disabled by default.
- `search`: an optional internal OpenSearch node for synthetic data and CI. PostgreSQL remains
  authoritative. See the [OpenSearch profile instructions](../README.md#optional-opensearch-profile).

GitHub Actions invokes these same services rather than maintaining a separate host npm workflow.

## Employee notifications (SD-040)

A ticket's requester gets an in-app notification when something they can see changes. The notification row is inserted by `appendEvent` **in the same transaction as the audit event**, so a rolled-back change leaves neither, and a committed one always has its notification. The recipient is always the ticket's requester, read from the ticket row inside the insert, never supplied by a caller.

| Ticket event                       | Notification type       | Notes                                              |
| ---------------------------------- | ----------------------- | -------------------------------------------------- |
| `TEAM_ASSIGNED`, `TEAM_REASSIGNED` | `TICKET_ASSIGNED`       |                                                    |
| `STATUS_CHANGED`                   | `TICKET_STATUS_CHANGED` | includes auto-triage and close                     |
| `RESOLVED`                         | `TICKET_RESOLVED`       |                                                    |
| `REOPENED`                         | `TICKET_REOPENED`       | only when someone other than the requester reopens |
| `COMMENT_ADDED` (public)           | `TECHNICIAN_REPLY`      | only when someone other than the requester replies |

- **No self-notification, no inactive recipients:** the actor is never notified of their own action, and a deactivated requester gets nothing.
- **Never notified:** internal notes, AI review decisions, assignee, category and priority changes, and ticket creation. A comment whose `isInternal` flag is missing or malformed is treated as internal.
- **Deduplication:** `(recipient_id, event_id, type)` is unique and the insert uses `ON CONFLICT DO NOTHING`, so recording the same event twice yields one user-visible item.
- **No stored text:** `notifications` holds ids, the type and `read_at`. The wording is derived from the type and the ticket when it is read, so comment bodies and internal-note text cannot reach a notification.

### Notification centre (SD-042)

Employees get a bell with an unread badge in the shell (sidebar on desktop, header on mobile). One shared state (`useNotificationCentre`) feeds both layouts, so there is a single poller: `GET /api/notifications?limit=10` every `NEXT_PUBLIC_TICKET_POLL_MS` (default 15 s) while the tab is visible, on every navigation and whenever the panel opens. The badge and the unread count always come from the server's `unreadCount`, never from local arithmetic, and a failed poll keeps the last known badge. Each item links to the employee's own ticket page (`/employee/tickets/:id`), which the API already restricts to the requester, and opening it marks the notice read. Wording comes from the server and carries no comment text. There are no WebSockets or push services. Technicians and administrators have no bell, because notifications go to ticket requesters.

The panel is a non-modal dialog rendered into `<body>`: Escape or an outside click closes it and focus returns to the bell that opened it. It shows loading, empty and error states (with "Try again") and the 10 most recent notifications.

## Notification email, optional (SD-043)

Email is an extra channel, off by default (`EMAIL_TRANSPORT=none`). With it off the worker starts no email loop, nothing is ever sent, and the notification centre is exactly as complete as with it on. Local development and CI never send mail.

**Flow.** The in-app notification is written in the ticket's own transaction (SD-040) and is complete before email is considered. The worker then sweeps recent notifications into `notification_deliveries`, a queue with at most one row per notification (a unique key), claimed with `FOR UPDATE SKIP LOCKED` and a lease exactly like `ai_analysis_jobs`. The dispatcher only reads notifications and writes its own delivery rows, so a failing or unreachable mail server cannot roll back or delay a ticket change and cannot hide an in-app item.

- **No duplicates:** one delivery row per notification, so sweeping repeatedly, running several workers, or retrying never queues or sends a notification that was already delivered. Each email carries a stable `Message-ID` derived from the notification id. One unavoidable limit: if the worker dies after the mail server accepted a message but before the row is marked `SENT`, the lease expires and that one message is sent again.
- **Retries:** each claim is an attempt (`EMAIL_JOB_MAX_ATTEMPTS`, default 5). Temporary and network failures, timeouts and Gmail's daily limit go back to `QUEUED` after `EMAIL_JOB_BACKOFF_MS * 2^(attempt-1)` (default 30 s, capped at 1 hour). A rejected login or recipient fails immediately. Stored reasons are codes (`temporary`, `unavailable`, `rate_limited`, `auth_failed`, `rejected`, ...), never server text.
- **Skipped, not sent:** the employee already read it in the app (`already_read`), the account was deactivated (`no_recipient`), or the delivery is older than `EMAIL_MAX_AGE_HOURS` (default 24, `expired`). The same age limit means switching email on later does not mail the existing history.
- **Content:** the wording and subject are fixed per notification type. The only free text is the requester's own ticket title and name (HTML-escaped, line breaks flattened). Comment text, resolution summaries, internal notes, AI prompts and credentials are not inputs. Links point to `APP_BASE_URL/employee/tickets/:id`.
- **Logs** carry delivery and notification ids, attempt numbers and reason codes only: never addresses, titles, message text, the SMTP host or any credential. Nodemailer's own logging is off.

### Using Gmail

1. On the sending Google account, turn on **2-Step Verification**, then create an **App Password** (Google Account > Security > App passwords). Your normal password does not work over SMTP.
2. Put the values in an untracked `.env` (never commit them):

   ```
   EMAIL_TRANSPORT=smtp
   SMTP_USER=your.address@gmail.com
   SMTP_PASSWORD=<the 16-character app password>
   APP_BASE_URL=http://localhost:3000
   ```

   `SMTP_HOST` (`smtp.gmail.com`), `SMTP_PORT` (587, STARTTLS required) and `SMTP_FROM` (defaults to `SMTP_USER`) are already right for Gmail. For implicit TLS use `SMTP_PORT=465`.

3. Start the worker (`docker compose up worker`). It logs `email transport: smtp` on start.

Limits to know: a personal Gmail account allows roughly 500 messages per day (Google Workspace more), and Gmail sends from the authenticated account regardless of `SMTP_FROM` unless the alias is verified. The Compose `worker` is on the `public` network so it can reach `smtp.gmail.com`; the database stays on the internal network.
