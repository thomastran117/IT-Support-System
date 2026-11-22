# Architecture

SmartDesk is a small service-oriented application packaged as one Docker Compose project.

## Runtime services

```text
Browser -> frontend (Next.js) -> backend (Fastify) -> PostgreSQL
                                      ^                 ^
                                      |                 |
                                      +---- worker -----+
```

- **Frontend** renders the employee, technician, and administrator portals. The browser calls the
  API at `NEXT_PUBLIC_API_URL`; the frontend does not connect to PostgreSQL.
- **Backend** owns HTTP authentication, authorization, validation, ticket workflows, database
  migrations, and seed/documentation commands.
- **Worker** is the host for asynchronous work: the Compose `worker` service runs the backend's
  `src/worker.ts` entrypoint (see Analysis queue and worker). It remains functional when the
  optional AI provider is disabled. The `worker/` package is a leftover heartbeat stub that Compose
  no longer starts.
- **PostgreSQL** is reachable only on Compose's internal network. Only the frontend and backend
  publish host ports.

## Package boundaries

Every package is independently locked and installed in its container image.

- `packages/contracts` contains browser-safe TypeScript types, constants, and Zod schemas. It must
  not import Node-only, Fastify, PostgreSQL, or Prisma code.
- `packages/db` exports the generated Prisma client and PostgreSQL adapter used by the backend and
  worker. Prisma generates its client from `backend/prisma/schema.prisma` during image builds.
- Applications depend on shared packages through local `file:` references. Docker builds contracts,
  generates Prisma, and builds the database package before starting a consumer.

There is intentionally no root npm workspace. Cross-package ordering belongs to the Docker build
and verification scripts in `docker/`.

## Request and data flow

All API responses use the envelope `{ message, error, details, data }` and include an
`X-Request-Id`. The backend validates untrusted input at the route boundary and obtains identity
from the access token rather than request bodies. Database changes that span records use Prisma
transactions; append-only comments and events are additionally protected by database triggers.

The frontend holds the access token in memory. Its API client performs at most one shared refresh
and one retry after a 401. Route guards improve navigation, but the backend independently authorizes
every request.

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
and their decisions stay visible under "Earlier suggestions". Triggering an analysis from the page
and showing queued, running or failed job states belong to SD-038.

## AI provider (backend and worker only)

`backend/src/modules/ai/` defines the advisory AI boundary. `AIProvider.analyse()` takes the ticket text, the active category/team allowlists and retrieved knowledge articles and returns a `ValidatedProposal`, or throws a classified `ProviderError` (`disabled`, `timeout`, `rate_limited`, `unavailable`, `malformed`, `invalid_reference`; the first four transient kinds are marked retryable).

- `AI_PROVIDER` selects `none` (default; analysis unavailable, ticketing unaffected), `fake` (deterministic, used by CI) or `openai`. `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS` and `AI_MAX_INPUT_CHARS` configure the live adapter. The key is read only by the backend and worker, is sent only in the provider's `Authorization` header, and is never logged or placed in error messages.
- Model output must match a strict Zod schema (category/team UUIDs, priority `LOW|MEDIUM|HIGH|CRITICAL`, bounded troubleshooting text, optional 0..1 `confidence`, optional cited article IDs). Category, team and article IDs are then checked against the allowlists supplied for that request; hallucinated values are rejected, not repaired.
- `confidence` is the model's self-reported score and is not a calibrated probability. A proposal is a draft: this module never changes a ticket.

### Ticket analysis (SD-034)

`createAnalysisService({prisma, provider}).analyse(ticketId)` in `analysisService.ts` returns an `AnalysisDraft` (a validated proposal plus `retrievedArticleIds`). It only reads: it never updates a ticket, writes a recommendation (that is SD-036) or exposes any tool or API to the model.

1. Loads the ticket title and description and the **active** categories and teams.
2. Retrieves up to 5 **published** articles through `searchPublished` (the same path as the knowledge search API) using a loose OR query of distinctive words from the redacted ticket text.
3. Redacts and truncates ticket and article text, and sends only title, description, the allowlists and the articles. The requester's name, email, id and ticket metadata are never sent.
4. Calls the provider, then re-checks the category, team and cited article IDs against what was actually sent. Cited articles are returned in retrieval order.

Ticket text and article text are untrusted: the prompt serialises them as one JSON document and tells the model to treat them as data. The real defence is structural, since output that is not a valid, allowlisted proposal is rejected and nothing else is acted on.

**Redaction limits.** `redact.ts` is pattern based. It removes emails, credentials in URLs, bearer/JWT/API-key style tokens, `password: ...` style assignments, long hex/base64 strings, card-like and SSN-like numbers and private-key blocks. It cannot recognise names, addresses, free-form passphrases or secrets written in prose, so users should not paste credentials into tickets. Retrieval query text is redacted too, and nothing in this module logs ticket or article text.

### Analysis queue and worker (SD-035)

Analysis never runs inside the ticket request. When `AI_PROVIDER` is not `none`, `POST /api/tickets` inserts a row into `ai_analysis_jobs` **in the same transaction as the ticket**, so a job exists if and only if the ticket does and dispatch cannot be lost between commit and queueing. The response returns 201 without calling the provider. An idempotent replay of a submission queues nothing new.

The worker is a second entrypoint of the backend package (`src/worker.ts`, `npm run start:worker`; Compose service `worker`). It is a separate process, shares the AI and repository code, and never imports Fastify.

- **Claiming:** `FOR UPDATE SKIP LOCKED` with a lease and a rotating `lease_token`. Several workers can run at once and never take the same job. `AI_WORKER_CONCURRENCY` caps parallel analyses per process.
- **Idempotency:** `(ticket_id, request_id)` is unique, so enqueueing the same request twice gives one job; a re-analysis uses a new request id.
- **Retries:** each claim counts as an attempt (`AI_JOB_MAX_ATTEMPTS`, default 3). Retryable failures (`timeout`, `rate_limited`, `unavailable`, unexpected errors) go back to `QUEUED` after `AI_JOB_BACKOFF_MS * 2^(attempt-1)`, capped at 15 minutes. Non-retryable ones (`malformed`, `invalid_reference`, `disabled`, `ticket_missing`) and exhausted jobs become `FAILED` with an `error_kind` reason code, never message text.
- **Crash recovery:** a worker that dies leaves a `RUNNING` row whose lease expires; another worker re-claims it. A job that keeps killing its worker ends as `FAILED(worker_lost)`.
- **Exactly-once effect:** completing a job, and any write that must happen once (the recommendation, SD-036), run in one transaction guarded by the lease token. A stale worker that finishes late finds its token gone and its result is discarded, so duplicate delivery cannot create a second result.
- **Shutdown:** on SIGTERM the worker stops claiming and lets in-flight analyses finish (bounded by their timeout); anything unfinished is retried via lease expiry.
- **Logging:** structured lines with job, ticket and request ids, attempt, state and reason code only.

### Recommendation persistence (SD-036)

`persistRecommendation` (`recommendationService.ts`) is the worker's `persist` hook. It runs inside the transaction that completes the job, and writes one `ai_recommendations` row plus its `recommendation_articles` links.

- **One row per attempt:** `ai_recommendations.job_id` is unique, so retries and duplicate delivery produce exactly one recommendation and never re-link articles. Re-analysis is a new job and therefore a new row; earlier rows and their review decisions are kept. `job_id` is NULL for rows that did not come from a job (fixtures, history).
- **Atomic:** the row and its links commit together or not at all. Any validation or database error throws and rolls the whole graph back; the job is then retried as an ordinary failed attempt.
- **Validated when written:** active category and team, priority in `LOW|MEDIUM|HIGH|CRITICAL`, confidence within 0..1 (rounded to 3 decimals), non-empty troubleshooting text, and a model version of at most 100 characters. Sources must exist, be published and not repeat; ranks are 1..n in retrieval order.
- **Model metadata:** `model_version` is `<provider>:<model>@prompt-<version>` (for example `openai:gpt-4o-mini@prompt-v2`), so a recommendation can be traced to its prompt.
- **Immutable proposal:** review state starts `PENDING` and the ticket is not changed. The only later update path, `markReviewed`, writes review columns only; accept, override and reject leave every `proposed_*`, `suggestion`, `confidence` and `model_version` value, and the source links, as they were. This is enforced in the service, not by a database trigger.

## Development and validation

`docker compose up --build --watch` synchronizes application source. Shared-package, manifest, and
Prisma changes trigger image rebuilds so consumers always use compiled package output.

Compose profiles add one-shot services without affecting the normal stack:

- `ci`: formatting, backend/database/worker verification, and browser-enabled frontend tests.
- `tools`: generated documentation commands whose output is mounted back into the repository.

GitHub Actions invokes these same services rather than maintaining a separate host npm workflow.
