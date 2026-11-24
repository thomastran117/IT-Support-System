# ADR — Incremental Node.js service extraction

**Proposed for SD-087.** The modular Fastify API and worker satisfy the functional MVP architecture.
E14 is an optional post-MVP extension. It brings the repository closer to the Deliverable 1
gateway, ticket, AI, notification, and analytics deployment model. Knowledge and Identity can stay
in the existing API until their separate extractions are justified. E14 adds no submission
prerequisite to E00–E11. [Epic E14](https://github.com/thomastran117/IT-Support-System/issues/118)

## Current implementation and ownership

The browser uses the Next.js frontend and the public Fastify API. `backend/src/app.ts` registers the
HTTP modules on one instance. Compose runs `backend/src/worker.ts` separately from the API, using
the same backend build, environment loader, and Prisma adapter. The worker runs the PostgreSQL AI
queue and, when configured, the SMTP dispatcher and OpenSearch indexer. The API and worker
currently connect to the same database and use the same Prisma model. [Runtime architecture](../architecture.md)

| Deliverable 1 boundary | Current module, data, and dependency                                                                                                                                                                                                               | Planned ownership and permitted interactions                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API gateway            | `app.ts` handles CORS, request IDs, rate limiting, and error envelopes. Compose exposes the API port directly.                                                                                                                                     | Gateway owns public routing, request correlation, and transport limits. It has no database or business-write privileges. It forwards browser credentials and requests to the current route owner.                                                                                                                                                                               |
| Ticket                 | `modules/tickets`, `modules/technician`, `modules/teams`, `modules/evaluation`, and `db/services/ticketService.ts` handle ticket workflows, staff queues, catalog, and label administration. `modules/search/ticketSearch*.ts` runs ticket search. | Ticket owns `tickets`, `ticket_comments`, `ticket_events`, `support_teams`, `team_members`, `ticket_categories`, `ai_recommendations`, `recommendation_articles`, and `classification_labels`. It publishes committed ticket events, supplies scoped analysis inputs, records proposals through an authenticated command, and keeps Q01–Q04 and ticket visibility checks local. |
| AI                     | `modules/ai` handles prompt creation, retrieval, provider calls, and validation. Ticket routes enqueue and read `ai_analysis_jobs`. The worker leases jobs and currently persists proposals and article links when completing them.                | AI owns provider configuration and analysis execution. The existing PostgreSQL queue can stay behind Ticket-owned lease commands during extraction. AI receives one job's allowlisted Ticket and published Knowledge inputs and submits a validated proposal tied to that job. Ticket owns the durable recommendation, reviewed outcome, and ticket values.                     |
| Notifications          | `db/repositories/ticketEvents.ts` writes `notifications` with eligible audit events. `modules/notifications` serves the inbox and runs optional SMTP backed by `notification_deliveries`.                                                          | Notifications owns the inbox, recipient-scoped reads and read state, delivery attempts, and its processing checkpoints. It consumes committed, eligible ticket events and can resolve addresses through scoped Identity lookup. Ticket publishes without waiting for inbox or email processing.                                                                                 |
| Analytics              | `modules/reports` and `db/repositories/reports.ts` run Q05–Q14 over PostgreSQL facts owned by Ticket. Admin label writes are served by `modules/evaluation`.                                                                                       | Analytics owns the two report endpoints, query definitions, and any future report projection. It can read narrowly scoped views or consume events to build a projection. Ticket keeps independent reference labels and their existing routes.                                                                                                                                   |
| Knowledge              | `modules/knowledge` owns CRUD, publication, and search over `knowledge_articles`. The AI worker uses the published search adapter. Articles depend on Ticket categories and are referenced by saved recommendations.                               | Knowledge owns article lifecycle and published retrieval, including article index-change intent. It can read category references through a scoped Ticket contract. It supplies bounded published results to AI. Ticket retains historical recommendation links and applies publication rules when exposing article content.                                                     |
| Identity               | `auth/`, `modules/auth`, and `modules/admin` handle sessions, credential and role changes, guards, and administrator audit over `users` and `admin_audit_log`. Guards and repositories read active account and team state.                         | Identity owns accounts, Argon2 hashes, token versions, session behavior, and account audit. It provides scoped account state and revocation checks. Ticket owns team membership and assignment rules.                                                                                                                                                                           |

Table names refer to the current [Prisma schema](../../backend/prisma/schema.prisma). The shared
`search_index_jobs` table records Ticket and Knowledge projection changes in their source
transactions. Retain it as a transitional outbox with producer access scoped to each entity type.
The index worker and rebuild tooling get access to the relevant projection fields, their aliases,
and the `search_rebuilds` checkpoints. Redis cache and rate-limit state are transient. OpenSearch
indexes are derived and PostgreSQL verifies authorization, publication, and freshness before a
result is returned. [Database and outbox](../database.md#search-outbox)

## Compatibility and transactions

- Keep frontend paths and base URL stable. The gateway starts by forwarding `/api/*` and both
  health routes to the current API. Move an explicit method/path group to its new owner at a time.
  Preserve statuses, DTOs, error envelopes, body limits, CORS with credentials, bearer headers,
  `X-Request-Id`, `Idempotency-Key`, retry headers, and `409` version conflicts. Forward every
  `Set-Cookie` value and retain `sd_refresh` path, rotation, origin checks, and logout behavior.
  Expose only the gateway and frontend. Bound proxy waits and return safe 502/503 responses.
  Preserve the caller's idempotency key through the hop and leave mutation retries to the caller.
  [API reference](../api.md) · [Session model](../authentication.md#session-model)
- The owning service checks the current user's active status, token version, role, and resource
  scope. The gateway strips caller-supplied internal actor and service headers and trusts forwarding
  metadata only from configured proxies. Internal commands require scoped, short-lived service
  credentials checked for expiry and audience. A service credential identifies a system actor.
  User-initiated commands still require validated user context. Propagate correlation IDs through
  internal calls and jobs. Log IDs, reason codes, and durations with credential and content
  redaction.
- Keep ticket creation, routing approval, status transitions, comments and first response, and
  human recommendation review in Ticket PostgreSQL transactions with their applicable audit events
  and outbox intents. Retain submission idempotency, conditional ticket versions, append-only
  event/comment history, and a single review decision per recommendation. Approval or override
  applies human-approved values and writes the review and audit atomically. Rejection records the
  decision and audit. The proposal and article links stay immutable across all decisions.
  [Routing](../api.md#routing-approval) · [Review](../api.md#reviewing-an-ai-recommendation)
- Record outbox events in the source transaction for ticket creation, routing, status, eligible
  public replies, and recorded recommendations. Use stable event IDs, event and schema versions,
  aggregate ID and version, occurrence time, correlation ID, and a minimal payload. Multiple
  events can share a ticket version, including comments, so deduplicate by event ID and give
  consumers an ordering rule appropriate to their projection. Keep private notes, ticket and
  article text, prompts, and credentials out of distributed event payloads. Consumers commit
  deduplication and local effects together, acknowledge after commit, and support bounded retries,
  dead-letter inspection, and replay. PostgreSQL remains the durable transport.
  [Cross-service outbox](service-outbox.md)

After notification cutover, the inbox reflects committed ticket events when its consumer catches
up. Ticket records notification intent using the same eligibility rules as its current insert,
including an active requester, a different actor, and an eligible event type. The intent carries
the recipient ID and notice type so delayed processing uses the original event decision. The inbox
checks the caller and recipient again on every read or update.

### AI handoff

Keep `ai_analysis_jobs` rows, `(ticket_id, request_id)` uniqueness, existing lease tokens and
expiries, attempt counts, and safe failure codes. Ticket creation and initial enqueue commit
together when analysis is enabled. Ticket continues to authorize the public analysis status and
retry endpoints. AI claims through a scoped lease interface and receives only the inputs required
for the claimed job. Revalidate publication and article revision before retrieval, redact and bound
ticket and article text sent to the provider, and validate proposed category, team, and citation
IDs against the allowlists.

Initially, place completion behind Ticket's authenticated command. Ticket checks the job, current
lease token, proposal references, and article publication and commits the pending recommendation,
article links, and job completion in one local transaction. After a lost response, the same
completion request returns the committed result for that job. A stale worker cannot finish another
worker's claim or replace a saved proposal. The unique recommendation job ID still permits a new
recommendation for an explicit re-analysis with a new job ID. If a later migration makes the queue
independently owned by AI, atomically store the validated proposal under the current lease and move
the job into an acknowledgement-pending state. That state permits retries of the saved completion
command until Ticket acknowledges it. AI can then mark its local job complete. After a crash, a
worker resumes the saved command without rerunning the provider or replacing the proposal.
[Existing queue and persistence](../architecture.md#analysis-queue-and-worker-sd-035)

## Migration and rollback

Use independently installed Node.js/TypeScript/Fastify packages with package-local npm lockfiles,
validated environment settings, separate images, and Compose health/readiness checks. Keep a
single PostgreSQL server initially. Give each runtime its own role and grant only its own writes
and explicitly permitted reads. Use a separate migration role. The shared Prisma adapter currently
provides a broad client, so database grants enforce the boundary even while code shares generated
types. Keep existing foreign keys and IDs during this transition, including user, team, category,
job, and article references. Document read views, any temporary grants, and the condition for
retiring each one. A broker or Kubernetes can be considered separately if a later need warrants it.

Introduce additive migrations and compatible event readers before enabling a new owner. Install
the existing and new releases against a disposable copy of the upgraded schema and rehearse forward
and reverse routing. Backfill from an explicit checkpoint while recording new writes in the
outbox. Reconcile counts, IDs, and state after replay. Drain the old handler, switch route and
runtime write authority together for the affected capability, and retain a tested route back to
the previous handler over current data. To revert, drain the new writer, restore the previous
owner's scoped grants, and replay outstanding work from the saved checkpoint. Keep durable data,
leases, and dedupe rows through either switch. Defer destructive schema changes until the rollback
window closes and a restore drill succeeds.

| Order and issue                                                                                                                | Cutover gate                                                                                                                                                                                                                                                                                                                                                                                          | Rollback                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SD-088](https://github.com/thomastran117/IT-Support-System/issues/140) Gateway                                                | Forward all API and health routes. Verify the three role journeys, session cookies, request IDs, idempotency, and bounded upstream failures on the original public port.                                                                                                                                                                                                                              | Restore the API as the sole public listener on the same origin and port.                                                                                                                                                                                                                                                               |
| [SD-089–SD-092](https://github.com/thomastran117/IT-Support-System/issues/118) Internal auth, Compose, database access, outbox | Deny forged actors and unauthorized cross-owner writes. Verify independently built containers, migration of existing data, replay and duplicates, and compatible event versions before cutting traffic over.                                                                                                                                                                                          | Keep serving via the current API and worker. Leave additive schema and any queued events in place so consumption can resume. Restore previous scoped credentials before re-enabling an old handler.                                                                                                                                    |
| [SD-093](https://github.com/thomastran117/IT-Support-System/issues/145) AI                                                     | Start the new runner against the existing leases with the fake provider first. Test retry, crash after claim, lost completion response, and a stale lease. Verify one saved proposal per job, an unchanged manual workflow with AI down, and bounded retry state.                                                                                                                                     | Stop new claims and drain or expire leases. Re-enable the existing AI runner against the same queue, keep its queued jobs and saved reviews, and leave email and search loops active if configured.                                                                                                                                    |
| [SD-094](https://github.com/thomastran117/IT-Support-System/issues/146) Notifications                                          | Record notification intent alongside eligible events while the existing inbox writes continue. Reconcile event replay into the same authoritative inbox using `(recipient_id, event_id, type)`. Preserve requester eligibility, internal-note exclusion, read state, and SMTP delivery rows, then hand off inbox and SMTP ownership. Gate on downtime, backlog recovery, and recipient authorization. | Pause the new consumer and SMTP dispatcher. Re-enable legacy inbox and delivery handling against the same data. Replay outstanding intents into the inbox so notices emitted during the handoff remain visible. Use stable message IDs and retain the existing SMTP acknowledgement ambiguity if a worker dies immediately after send. |
| [SD-095](https://github.com/thomastran117/IT-Support-System/issues/147) Analytics                                              | Switch both report endpoints after parity checks for Q05–Q14, including half-open UTC windows, first routing and public response, reopened tickets, missing AI, and empty denominators. Enforce ADMIN at the service. If using a projection, expose freshness and reconcile it with source facts.                                                                                                     | Route reports back to the original SQL handlers. Retain Ticket labels and facts and any projection checkpoints.                                                                                                                                                                                                                        |
| [SD-096](https://github.com/thomastran117/IT-Support-System/issues/148) Knowledge, stretch                                     | Verify published lookup and draft denial through the gateway and AI interface. Check article revisions, historical links, and index replay with OpenSearch disabled as well as enabled.                                                                                                                                                                                                               | Drain the new Knowledge writer and return API and AI reads to the existing module over the same article rows. Preserve search revisions and replay pending index intent before changing aliases.                                                                                                                                       |
| [SD-097](https://github.com/thomastran117/IT-Support-System/issues/149) Identity, stretch                                      | Verify existing hashes, cookie rotation, role/deactivation revocation, one-time password flows, and the last-admin guard. Preserve current account validation during Ticket operations and active membership checks within Ticket.                                                                                                                                                                    | Drain the new account writer and route auth and user administration back to the existing handlers. Keep current hashes, token versions, credentials configuration, and audit rows so a rollback cannot re-enable revoked credentials.                                                                                                  |
| [SD-098](https://github.com/thomastran117/IT-Support-System/issues/150) Ticket isolation                                       | Move remaining ticket, team/catalog, triage, comments, audit, and human review routes in groups. Verify one active route owner, Q01–Q04, and transaction parity for manual and AI-assisted flows.                                                                                                                                                                                                     | Revert one route group at a time to the compatible legacy build over current rows. Keep the new outbox contract active so extracted consumers still receive ticket events. Retire old handlers only after integrated regressions and rollback pass.                                                                                    |

Build in issue order from reviewed, merged predecessors. Carry correlation IDs from the gateway
and the first outbox envelope, then verify the cross-service trace in SD-099. SD-100 exercises the
adopted stack and rollback over real HTTP and PostgreSQL. SD-101 records the deployed boundaries
and links measured evidence back to Deliverable 1.
[E14 issues and dependencies](https://github.com/thomastran117/IT-Support-System/issues/118)

## Dependency outages

| Dependency                      | Expected behavior and recovery                                                                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI service or provider          | Ticket create, triage, routing, transitions, and review of existing recommendations continue. Jobs remain claimable or reach a bounded failure state with an explicit retry path. A recovering worker picks up durable work.                                                                                |
| Notifications or SMTP           | Ticket writes and audit continue. The inbox can return a bounded unavailable response. Retain committed notification intents and replay the backlog with dedupe. SMTP failures retry independently of the inbox.                                                                                            |
| Analytics                       | Report calls fail within their upstream budget. Ticket writes and independent label administration remain available.                                                                                                                                                                                        |
| Knowledge, OpenSearch, or Redis | Manual ticket operations still use PostgreSQL. Knowledge unavailable yields a bounded result or failure for AI under the existing retry policy. OpenSearch failures use authorized PostgreSQL search. Redis failures fall through to PostgreSQL for cached reads and to the configured rate-limit fallback. |
| Identity                        | When current account state cannot be verified, fail protected operations closed. A transitional owner-approved PostgreSQL read view can supply current account state with the same revocation checks. Cached roles or stale tokens cannot widen access.                                                     |
| Ticket or PostgreSQL            | Report affected readiness and fail operations that require source data within their budgets. Resume from the last committed state after recovery.                                                                                                                                                           |

## Baseline and success gates

The pre-migration reference is `main` at `e9a87c7`, the merge of SD-086. E00–E09 are closed.
The SD-086 merge PR passed backend and frontend verification. It provides an initial E10 baseline
for contract, PostgreSQL, worker, and browser regressions. The backend suite tests real PostgreSQL
and the optional OpenSearch path. Most frontend journeys mock the API, while the separate
ticket-search browser check runs against the real stack. E10's broader real-stack journeys and
static/dynamic reports remain tracked in E10.
[Baseline PR checks](https://github.com/thomastran117/IT-Support-System/pull/190/checks) · [E10](https://github.com/thomastran117/IT-Support-System/issues/11)

Reproduce the current checks from the baseline revision in a disposable environment.

```bash
docker compose --profile ci run --rm format-check
docker compose --profile ci run --rm backend-ci
docker compose --profile ci run --rm frontend-ci
```

Run those checks on every extraction and verify the cutover gate in the migration table. Before
retiring legacy routes, run real browser-to-gateway journeys for employee, technician, and
administrator actions. Include session rotation and revocation, cross-role and cross-recipient
denials, private-note exclusion, stale writes, report parity, protected-service access without a
gateway, and rollback against existing records. Stop AI, Notifications, and search dependencies
individually while completing manual ticket and audit workflows. Restart consumers and demonstrate
dedupe and recovery with pending, duplicate, and out-of-order work. Trace a synthetic ticket
through creation, analysis, review, and notification using correlation IDs.

Use identical fixtures, request mix, concurrency, Compose resources, and warm-up for pre/post
measurements. Record the commit, command, workload, dependency state, and sample window with p50
and p95 request latency, errors, container CPU and memory, and queue age and recovery time. Use the
existing search and Redis workloads where applicable and measure manual writes and gateway
overhead explicitly. Agree on budgets from the baseline before switching traffic. Record observed
results, remaining gaps, and the rollback drill in SD-100/SD-101.
[Search workloads](../search-evaluation.md#reproduction) · [Redis workloads](../redis-evaluation.md#running-it)
