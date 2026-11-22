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
  optional AI provider is disabled.
- **PostgreSQL** is reachable only on Compose's internal network. Only the frontend and backend
  publish host ports.
- **Redis** is an optional, internal-only cache with no persistence, disabled unless the `cache`
  (dev) or `ci` profile starts it; PostgreSQL remains the authoritative store regardless.

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
