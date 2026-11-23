# API reference

The API is available at `http://localhost:4000` by default. Except for health responses, JSON uses:

```json
{ "message": "Human-readable summary", "error": null, "details": null, "data": {} }
```

Errors set `error`, may add structured `details`, and set `data` to `null`. Authenticated endpoints
expect `Authorization: Bearer <access-token>`. Every response includes `X-Request-Id`.

## Health and utilities

| Method | Path            | Purpose                                            |
| ------ | --------------- | -------------------------------------------------- |
| GET    | `/health/live`  | Process liveness; does not require the database    |
| GET    | `/health/ready` | Readiness and database status                      |
| GET    | `/api/ping`     | Auth-free API example with the current server time |
| POST   | `/api/echo`     | Auth-free strict `{ "text": "..." }` echo          |

## Authentication

| Method | Path                | Request / result                                               |
| ------ | ------------------- | -------------------------------------------------------------- |
| POST   | `/api/auth/login`   | `{email,password}`; returns an access token and refresh cookie |
| POST   | `/api/auth/refresh` | Rotates the refresh cookie and returns a new session           |
| POST   | `/api/auth/logout`  | Clears the refresh cookie                                      |
| GET    | `/api/auth/me`      | Returns the current public user profile                        |

Refresh and logout require an `Origin` equal to `FRONTEND_ORIGIN`. Details are in
[Authentication and authorization](authentication.md).

## Tickets

All ticket endpoints require authentication. Visibility is role-scoped: employees see their own
requests, technicians see their requests plus active-team work and the unrouted backlog, and
administrators see all tickets. Unknown and unreadable ticket IDs both return 404.

| Method | Path                           | Purpose                                             |
| ------ | ------------------------------ | --------------------------------------------------- |
| POST   | `/api/tickets`                 | Create a ticket for the signed-in requester         |
| GET    | `/api/tickets`                 | List visible tickets with filters and offset paging |
| GET    | `/api/tickets/search`          | Search visible tickets by text or tracking ID       |
| GET    | `/api/tickets/:id`             | Read detail, visible comments, and timeline         |
| GET    | `/api/tickets/:id/comments`    | List visible comments                               |
| POST   | `/api/tickets/:id/comments`    | Append a public comment or authorized internal note |
| GET    | `/api/tickets/:id/events`      | Read the role-filtered immutable timeline           |
| POST   | `/api/tickets/:id/transitions` | Change status using optimistic concurrency          |

### Create and list

`POST /api/tickets` accepts the strict body `{ "title": string, "description": string }`.
Titles are trimmed and limited to 150 characters; descriptions are nonblank and limited to 5000.
The server assigns requester, status, priority, routing, timestamps, and version.

Clients may send `Idempotency-Key` containing 8-100 printable ASCII characters. Replaying the same
key and body for one requester returns the original ticket with status 200 and
`Idempotent-Replay: true`; reusing the key with different content returns 409.

`GET /api/tickets` accepts optional `status`, `priority`, `limit` (1-100, default 20), and `offset`
(default 0). It returns `{items,total,limit,offset,nextOffset}` newest first.

### Ticket search

`GET /api/tickets/search` requires authentication and a `q` of 1-160 characters after trimming,
including at least one letter or number. The optional query parameters are:

| Parameter                  | Accepted values                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `status`, `priority`       | A single ticket status or priority                                                           |
| `categoryId`               | Category UUID                                                                                |
| `teamId`                   | Team UUID. Technicians may select one of their active teams. Admins may select any team.     |
| `assigneeId`               | User UUID. Technicians may select their own account. Admins may select any account.          |
| `createdFrom`, `createdTo` | ISO 8601 timestamps with offset. The lower bound is inclusive and the upper bound exclusive. |
| `sort`                     | `relevance` (default), with ticket ID ascending for equal scores                             |
| `limit`                    | 1–100, default 20                                                                            |
| `cursor`                   | The previous page's `nextCursor`, with the same text, filters, and limit                     |

Employees can use status, priority, category, and creation date filters on their own tickets.
Out-of-scope filters return `403`. Unknown or repeated parameters, invalid limits and date ranges,
and invalid cursors return `400`. The endpoint allows 30 requests per minute per account and returns
`429` when that budget is exhausted.

Search returns `{ mode, consistency, items, nextCursor }` inside the usual response envelope:

- A full ticket UUID uses `mode: "exact"` and `consistency: "current"`. PostgreSQL returns at most
  one summary, including when OpenSearch is disabled. Missing, unreadable, and excluded tickets
  all yield an empty page. The exact lookup always has a null cursor.
- Other text uses `mode: "text"` and `consistency: "eventual"`. OpenSearch ranks title and description
  matches with BM25, a title boost, and bounded typo tolerance. PostgreSQL rechecks visibility and
  filters before returning summaries. A new or changed ticket may take time to appear. The cursor
  expires after 10 minutes and is bound to the account, role, active teams, and the original query.
  Index changes can shift results between pages. [OpenSearch multi-match](https://docs.opensearch.org/latest/query-dsl/full-text/multi-match/)

Text search returns `503` with `details.code` set to `TICKET_SEARCH_DISABLED` or
`TICKET_SEARCH_UNAVAILABLE` when the optional index cannot serve the request.
`details.fallback` points to `/api/tickets` for the regular newest-first list. The technician queue
keeps its priority ordering.

### Comments and events

`POST /api/tickets/:id/comments` accepts `{ "body": string, "isInternal": boolean }`, where
`isInternal` defaults to false. Requesters may add public comments to readable tickets; only staff
with work access may add or read internal notes. Comments are append-only and do not increment the
ticket version.

The first public response from staff other than the requester sets `firstResponseAt`. Internal notes
and requester replies do not count. Comment text is never copied into timeline event details.

Timeline events are ordered by occurrence time and ID. Staff in scope see the complete sanitized
event and actor; requesters receive a reduced operational timeline without private actors, internal
comments, AI review details, or assignee changes.

### Status transitions

`POST /api/tickets/:id/transitions` accepts:

```json
{ "to": "IN_PROGRESS", "expectedVersion": 3, "resolutionSummary": "optional" }
```

The normal path is `OPEN -> TRIAGED -> IN_PROGRESS -> RESOLVED -> CLOSED`; resolved or closed
tickets may reopen to `OPEN`. Resolving requires a nonblank summary. Routing prerequisites apply
before triage. A stale `expectedVersion` returns 409 with the current version, and every successful
mutation increments the version.

### Routing approval

`POST /api/tickets/:id/routing` records a technician's approved category, priority and team, with an
optional assignee, in one request:

```json
{
  "categoryId": "<uuid>",
  "priority": "HIGH",
  "teamId": "<uuid>",
  "assigneeId": "<uuid>|null",
  "expectedVersion": 3
}
```

- Staff who can edit the ticket only (administrators; technicians in the ticket's team or, for an
  unrouted ticket, on any active team). The requester gets `403`; anyone who cannot read the ticket
  gets `404`. The body is strict: unknown fields (status, requester, ...) are `400`.
- `priority` is `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`. Category and team must be active, and the
  assignee must be an active technician in the chosen team (`422` otherwise). Omitting `assigneeId`
  keeps the current assignee when the team is unchanged and clears it when the team changes; `null`
  clears it. Use `GET /api/teams`, `/api/categories` and `/api/teams/:id/members` to fill the form.
- An `OPEN` ticket becomes `TRIAGED` once category, priority and team are all approved. Resolved or
  closed tickets cannot be re-routed (`409`; reopen first).
- Events are written in the same transaction: `CATEGORY_UPDATED`, `PRIORITY_UPDATED`,
  `TEAM_ASSIGNED` for the first team or `TEAM_REASSIGNED` for a later change, `ASSIGNEE_UPDATED`.
  A request that changes nothing writes nothing.
- A stale `expectedVersion` is `409` with `details.code = "VERSION_CONFLICT"` and the
  `currentVersion`; nothing is applied. Two concurrent approvals from the same version: exactly one
  succeeds.
- AI suggestions are never modified by this endpoint, and it works whether or not AI has run.

### Reading AI recommendations

`GET /api/tickets/:id/recommendations` returns the ticket's current and historical AI recommendations,
newest first (at most 50), as `RecommendationDto[]`: the original proposal (`proposed.category`,
`proposed.team`, `proposed.priority`), `suggestion`, the model's self-reported `confidence`,
`modelVersion`, the cited **published** knowledge articles in relevance order, and the review
(`status` of `PENDING`, `ACCEPTED`, `OVERRIDDEN` or `REJECTED`, reviewer, time and notes).
`proposed.category.isActive` and `proposed.team.isActive` are false when the proposal points at
something that has since been deactivated, so a client can steer the technician to override or reject.

Same access as routing approval: staff who can edit the ticket. The requester gets `403` (employees
never receive AI output) and anyone who cannot read the ticket gets `404`. Re-analysis adds a new
entry; earlier entries and their decisions are kept, and approved ticket values only change through a
review or manual routing.

### AI analysis status and retry

Staff who can edit the ticket (the requester gets `403`, an unreadable ticket `404`; the same rule as
recommendations) can see and request AI analysis. AI never gates ticket work: a failed, slow or
disabled analysis leaves the ticket `OPEN` and every routing, transition and review endpoint working.

`GET /api/tickets/:id/analysis` returns an `AnalysisStatusDto` for the newest analysis:

| Field                     | Meaning                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                 | `false` when no AI provider is configured (`AI_PROVIDER=none`).                                                               |
| `state`                   | `NONE`, `QUEUED`, `RUNNING`, `COMPLETED` or `FAILED`.                                                                         |
| `attempts`, `maxAttempts` | Claims so far and the cap before the job fails for good.                                                                      |
| `retryAt`                 | When a transient failure will be retried automatically (only while `QUEUED`).                                                 |
| `failure`                 | `{ reason, message }` for the latest failed attempt: the final one when `FAILED`, the transient one while a retry is pending. |
| `canRetry`                | `true` when a fresh analysis can be requested now.                                                                            |
| `manualCue`               | `{ highRisk, reasons[] }`: see below.                                                                                         |

`failure.reason` is one of `provider_unavailable`, `timed_out`, `rate_limited`, `invalid_response`,
`ticket_unavailable`, `worker_lost`, `ai_disabled` or `internal`. The wording is fixed by the server;
provider messages, ticket text and keys never appear in it, in logs, or in the stored job row.

`POST /api/tickets/:id/analysis` requests a fresh analysis (body optional: `{ "requestId": "<uuid>" }`).
It always creates a **new** job; earlier jobs, proposals and decisions are never modified. It answers
`202` with the new status, or `200` if the same `requestId` was already submitted (idempotent).

- `409` with `details.code`: `ANALYSIS_IN_PROGRESS` (one is already queued or running, so repeated or
  simultaneous clicks enqueue exactly one) or `AI_DISABLED`.
- `429` with `details.code` `ANALYSIS_RATE_LIMITED` after 5 requests for a ticket within an hour
  (the automatic first analysis counts).

`manualCue` is a deterministic keyword check of the ticket text (possible security incident, outage
affecting many users, requester cannot work, marked urgent). It is independent of AI, is computed on
read, is never stored or applied, and its reasons are fixed labels. It is a prompt for the technician to
look at the ticket first, not a recommendation, and is returned whether or not AI is enabled.

### Reviewing an AI recommendation

`POST /api/tickets/:id/recommendations/:recommendationId/review` records a technician's decision on
an AI recommendation:

```json
{
  "decision": "ACCEPTED | OVERRIDDEN | REJECTED",
  "expectedVersion": 3,
  "override": { "priority": "HIGH" },
  "notes": "optional"
}
```

- `ACCEPTED` approves the proposed category, priority and team. `OVERRIDDEN` applies the proposal
  with the technician's `override` values on top (at least one of `categoryId`, `priority`,
  `teamId`, `assigneeId`). `REJECTED` keeps the approved values as they are. `override` is only
  valid with `OVERRIDDEN`, and `notes` is limited to 2000 characters. The body is strict.
- Same access as routing approval: staff who can edit the ticket. The requester gets `403`; anyone
  who cannot read the ticket, and a recommendation that belongs to another ticket, get `404`. The
  reviewer is always the authenticated user.
- A recommendation can be decided once. A second decision, including a concurrent one, is `409`
  with `details.code = "STALE_WRITE"`; a stale `expectedVersion` is `409 VERSION_CONFLICT`.
- Everything is one transaction: the review status, reviewer and time, the approved ticket values
  (with the same events as manual routing) and an `AI_REVIEWED` event. If any part fails, none of it
  is applied and the recommendation stays pending. A proposal that points at a category or team
  that is no longer active therefore fails with `422`; override the stale value or reject instead.
- The original `proposed_*` values, suggestion, confidence and linked articles are never changed.
- The response is `{ ticket, recommendationId, decision }` with the ticket as approved afterwards.

## Administration

All `/api/admin` endpoints require the `ADMIN` role.

| Method | Path                                  | Purpose                                            |
| ------ | ------------------------------------- | -------------------------------------------------- |
| GET    | `/api/admin/users`                    | Filter/paginate users                              |
| POST   | `/api/admin/users`                    | Create a user and return a one-time password       |
| PATCH  | `/api/admin/users/:id/role`           | Change a role and revoke existing tokens           |
| POST   | `/api/admin/users/:id/deactivate`     | Deactivate without deleting history                |
| POST   | `/api/admin/users/:id/activate`       | Reactivate an account                              |
| POST   | `/api/admin/users/:id/reset-password` | Replace credentials and return a one-time password |
| GET    | `/api/admin/audit-log`                | Read recent administrator actions                  |

User listing accepts `role`, `active`, `q`, `limit` (maximum 200), and `offset`. The server prevents
self-demotion, self-deactivation, self-password-reset, and removal of the last active administrator.

## Administrator reports

`GET /api/admin/reports/summary?start=<iso>&end=<iso>` (ADMIN only; 401 anonymous, 403 otherwise).
Responses are `Cache-Control: no-store` and contain aggregates only: no ticket text, requester names,
emails or ids.

**Window.** Half-open UTC `[start, end)`. Each bound is an ISO-8601 date (`2026-03-01`, read as UTC
midnight) or a date-time with an explicit offset; values without an offset are rejected. `start` must
be strictly before `end` and the window may not exceed 366 days (`400` otherwise).

**Cohorts and denominators.**

| Block           | Cohort                                                                   | Denominator / rule                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitted`     | Tickets created in the window                                            | Shared denominator for routing and first response                                                                                                  |
| `routing`       | Same cohort (Q05)                                                        | `routed` = has a first `TEAM_ASSIGNED` event; unrouted tickets stay in `submitted`; reroutes never replace the first routing                       |
| `firstResponse` | Same cohort (Q11)                                                        | `responded` = `first_response_at` set: first public comment by a technician/admin who is not the requester; unanswered tickets stay in `submitted` |
| `resolution`    | Tickets currently RESOLVED/CLOSED with `resolved_at` in the window (Q06) | A reopened ticket has no `resolved_at` and is excluded until resolved again                                                                        |
| `aiAccuracy`    | Independently labelled tickets created in the window (Q07)               | Tickets with no valid AI recommendation stay in `labelledTickets` and count as not correct                                                         |
| `aiAcceptance`  | Recommendations reviewed in the window (Q08)                             | Separate from accuracy                                                                                                                             |
| `categories`    | Tickets created in the window by approved category (Q09)                 | `Uncategorized` for tickets without one                                                                                                            |
| `dailyIntake`   | One entry per UTC day touched by the window (Q10)                        | Zero-filled                                                                                                                                        |

Averages and percentages are `null` when the denominator is zero (never `0`). Counts are numbers.
Units are in `units`: routing and first response in minutes, resolution in hours, rates in percent.
AI processing latency is not measured as API time. The queries are the version-controlled
`backend/sql/reports/Q05`-`Q11` files.

The administrator UI for this endpoint is `/admin/reports`. It takes inclusive UTC calendar days
(`?from=YYYY-MM-DD&to=YYYY-MM-DD`) and requests the half-open window ending at the start of the day
after `to`. The chosen range is kept in the URL and for the browser session. Undefined averages and
rates are shown as `N/A`, never `0`.

## Independent AI evaluation

All endpoints are ADMIN only (401 anonymous, 403 otherwise). A label is the correct category as judged
by an administrator, kept in `classification_labels`, separate from AI recommendations and from the
technician-approved category.

| Method | Path                                          | Purpose                                                            |
| ------ | --------------------------------------------- | ------------------------------------------------------------------ |
| POST   | `/api/admin/tickets/:id/classification-label` | Create the label (`409` if one exists)                             |
| PUT    | `/api/admin/tickets/:id/classification-label` | Create or replace the label, recording the new editor and time     |
| GET    | `/api/admin/tickets/:id/classification-label` | Read one label                                                     |
| GET    | `/api/admin/classification-labels`            | Newest labels first (`limit` max 200, `offset`)                    |
| GET    | `/api/admin/reports/ai-evaluation`            | Accuracy, acceptance, per-model figures and confusion for a window |

The body is `{ "referenceCategoryId": "<uuid>" }` and nothing else (unknown keys such as `labelledBy`
are rejected with `400`). `labelledBy` and the time always come from the authenticated session. The
category must exist and be active (`422` otherwise); an unknown ticket is `404`. Writing a label never
reads or changes AI recommendations or the ticket.

**Report (`start`/`end` as for the summary report).**

- _Accuracy cohort:_ labelled tickets created in the window. The prediction is the **first valid
  recommendation** (earliest saved one that proposes a category). A ticket with no valid recommendation
  stays in `labelledTickets` and counts as not correct (`withoutRecommendation`), so missing or unusable
  output lowers accuracy rather than leaving the denominator. SQL: Q07 (overall), Q12 (per model), Q14
  (confusion).
- _Per model:_ a labelled ticket is attributed to the `model_version` that produced its first valid
  recommendation; tickets without one appear only in the overall figure.
- _Acceptance cohort:_ recommendations reviewed in the window (Q08, per model Q13). It is reported next to
  accuracy but is a different measure: accepting a suggestion is not the same as it being correct.
- `accuracyPct` and `acceptancePct` are `null` when their denominator is zero.
- `confusion` lists reference category by first valid predicted category; `predictedCategory: null`
  means no valid recommendation.

**Limits.** The figures are only as good as the label set: small, hand-picked or single-labeller sets
prove little, and the denominators are shown so that is visible. The 90% category-accuracy target is
**unverified** until a representative independently labelled set measures it. See
[ai-evaluation.md](ai-evaluation.md) for the offline dataset and the evaluated model/prompt versions.

## Support teams and reference data

Staff (`TECHNICIAN` or `ADMIN`) can read the reference lists that assignment forms need. Employees
receive `403`. These responses carry only what a dropdown needs: no emails, roles or account state.

| Method | Path                     | Purpose                                                                                         |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/teams`             | Active teams (`id`, `name`, `description`); `?mine=true` limits a technician to their own teams |
| GET    | `/api/teams/:id/members` | Active technicians of an active team (`id`, `displayName`)                                      |
| GET    | `/api/categories`        | Active ticket categories (`id`, `name`, `description`)                                          |

An inactive or unknown team returns `404` from the members list.

All `/api/admin/teams` endpoints require the `ADMIN` role.

| Method | Path                                   | Purpose                                                     |
| ------ | -------------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/admin/teams`                     | All teams, inactive included, with member and ticket counts |
| POST   | `/api/admin/teams`                     | Create a team (`name`, optional `description`)              |
| GET    | `/api/admin/teams/:id`                 | One team                                                    |
| PATCH  | `/api/admin/teams/:id`                 | Rename or change the description                            |
| POST   | `/api/admin/teams/:id/activate`        | Make the team assignable again (idempotent)                 |
| POST   | `/api/admin/teams/:id/deactivate`      | Stop offering the team; keeps members and ticket history    |
| GET    | `/api/admin/teams/:id/members`         | Members with email, account state and assigned-ticket count |
| POST   | `/api/admin/teams/:id/members`         | Add a member (`{ "userId": "<uuid>" }`)                     |
| DELETE | `/api/admin/teams/:id/members/:userId` | Remove a member                                             |

Rules:

- Teams are deactivated, never deleted, so historical tickets keep their team.
- Only an **active `TECHNICIAN`** can be added, and only to an **active team**; anything else is `409`.
  Adding an existing member is also `409`.
- A member **cannot be removed while any ticket (of any status) is assigned to them within that
  team**: the ticket's team/assignee pair references the membership. The `409` includes
  `details.assignedTicketCount`; reassign those tickets first.
- A technician **may belong to several teams**. Their working scope is the union of those teams'
  queues plus the shared unassigned backlog (see `docs/authentication.md`). Removing them from one
  team does not affect the others.
- Deactivating a team does not alter tickets already routed to it, and the admin list shows
  `ticketCount` (tickets of any status assigned to the team) so the effect is visible beforehand. A
  deactivated team is no longer accepted for new routing (`422`) and is not listed by `/api/teams`.

### Category administration

All `/api/admin/categories` endpoints require the `ADMIN` role (`401` anonymous, `403` otherwise).

| Method | Path                                   | Purpose                                                                 |
| ------ | -------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/admin/categories`                | All categories, inactive last, with `ticketCount`                       |
| POST   | `/api/admin/categories`                | Create (`name` up to 100 characters, optional `description`)            |
| GET    | `/api/admin/categories/:id`            | One category                                                            |
| PATCH  | `/api/admin/categories/:id`            | Rename or change the description                                        |
| POST   | `/api/admin/categories/:id/activate`   | Offer the category again (idempotent)                                   |
| POST   | `/api/admin/categories/:id/deactivate` | Stop offering it; tickets, articles, recommendations and labels keep it |

- Names are unique; a clash on create or rename is `409` with a message that names the problem.
  Unknown keys and empty or overlong names are `400`.
- There is **no delete**: categories are referenced by tickets, knowledge articles, AI
  recommendations and evaluation labels, so they are only deactivated.
- An inactive category is not listed by `/api/categories` and is rejected for new triage and when
  accepting or overriding an AI suggestion (`409`/`422`), while every existing reference keeps resolving it.

The administrator pages for this are `/admin/categories` and `/admin/teams` (membership included).
Deactivating asks for confirmation and states these effects first.

## Knowledge base

Article visibility is separate from ticket permissions. Two surfaces, split by who may see drafts.

**Readers**, `/api/knowledge`: any signed-in role (anonymous is `401`). Published articles only,
for every role, administrators included.

| Method | Path                        | Purpose                                                                                                         |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/knowledge`            | Page of summaries (`id`, `title`, `category`, `updatedAt`); `?categoryId=&limit=&offset=`                       |
| GET    | `/api/knowledge/categories` | Active categories with at least one published article, for the filter (employees cannot read `/api/categories`) |
| GET    | `/api/knowledge/:id`        | One article with `body`, `createdAt`, `updatedAt`                                                               |

### Search

`GET /api/knowledge/search?q=&categoryId=&limit=&offset=` ranks **published** articles by
relevance for any signed-in role. It returns `{ items, total, limit, offset, nextOffset }`; each
item is `{ id, title, category, preview, rank }` with a plain-text preview (whitespace collapsed,
200 characters plus an ellipsis). `id` is the source id AI suggestions cite.

- `q` is at most 200 characters (longer is `400`). Blank, punctuation-only and no-match queries
  return an empty page, never an error. `limit` is 1-20 (default 10), `offset` 0-1000.
- With OpenSearch enabled, plain text uses BM25 over title and body with a title boost, bounded
  typo tolerance, and article ID as the tie-breaker. PostgreSQL verifies publication, category,
  and revision before the API counts or returns a match. Recently changed articles can take
  time to appear. The API builds previews from PostgreSQL and derives `rank` from verified order.
- PostgreSQL full-text search handles quoted phrases, `or`, and `-term`. It also serves requests
  when OpenSearch is disabled, unavailable, or has more than 300 candidates. It uses the English
  `websearch_to_tsquery` function with a bound parameter and the partial GIN index on published
  rows (`idx_knowledge_articles_fts`, migration `0007`). Its order is weighted relevance, most
  recently updated, then article ID.
- An unknown `categoryId` yields an empty page. A page past the end still includes the full
  verified total.

**Authoring**, `/api/admin/knowledge`: `ADMIN` only (`403` otherwise).

| Method | Path                                 | Purpose                                                                |
| ------ | ------------------------------------ | ---------------------------------------------------------------------- |
| GET    | `/api/admin/knowledge`               | All articles with `isPublished`; also filters `?published=true\|false` |
| POST   | `/api/admin/knowledge`               | Create a **draft** (`title`, `body`, optional `categoryId`)            |
| GET    | `/api/admin/knowledge/:id`           | One article, draft or published                                        |
| PATCH  | `/api/admin/knowledge/:id`           | Change `title`, `body` and/or `categoryId` (`null` clears it)          |
| POST   | `/api/admin/knowledge/:id/publish`   | Make visible to readers (idempotent)                                   |
| POST   | `/api/admin/knowledge/:id/unpublish` | Hide from readers (idempotent)                                         |

Rules:

- A draft or unpublished article is `404` on the reader API, identical to an id that does not
  exist, so its existence is not revealed. The filter is applied in the database query.
- Lists are ordered by `updatedAt` descending then `id`, so pages are stable. `limit` is 1-50
  (default 20); a bad `limit`, `offset` or id is `400`.
- Title is 1-200 characters, body 1-20 000, both trimmed. A category must exist and be **active**
  (`422` otherwise); a write that fails validation changes nothing. Publishing an article whose
  category has since been deactivated is `409`.
- `body` is plain text with light Markdown and is **data, not HTML**. The server strips control
  characters and normalises line endings but does not rewrite markup, so clients must render it
  escaped (or with a Markdown renderer that disallows raw HTML).
- There is no delete. Recommendations reference articles through a restrictive foreign key, so
  unpublishing is the way to retire one; historical recommendation links stay intact.

## Technician queues

Staff-only (`TECHNICIAN` or `ADMIN`; employees get `403`). Scope is derived from the caller's active
team memberships, never from the request. Both endpoints return `{ items, total, limit, offset,
nextOffset }`, where `total` counts every match for the filters. Items carry summary fields only
(`id`, `title`, `status`, `priority`, `category`, `assignee`, `createdAt`, `ageMinutes`, `version`):
no description, comments or requester. Unknown query parameters are rejected with `400`.

| Method | Path                         | Purpose                                                       |
| ------ | ---------------------------- | ------------------------------------------------------------- |
| GET    | `/api/technician/queue`      | Unresolved tickets of one team (query Q02); `teamId` required |
| GET    | `/api/technician/unassigned` | OPEN tickets with no team yet (query Q03)                     |

Access rules:

- **Team queue:** a technician must belong to the (active) team, otherwise `403`; an administrator may
  read any team (`404` if it does not exist).
- **Unassigned backlog:** administrators, and technicians who belong to at least one active team. It
  is the same list for every triager regardless of team. A technician with no team gets `403`.

Filters (all optional, combinable): `priority` (comma list, e.g. `CRITICAL,HIGH`), `categoryId`,
`createdFrom` (inclusive) and `createdTo` (exclusive) as ISO 8601 timestamps with offset, `limit`
(1–100, default 20) and `offset`. The team queue also accepts `status` (comma list; defaults to
`OPEN,TRIAGED,IN_PROGRESS`) and `mine=true` (only tickets assigned to the caller). The backlog is
`OPEN` by definition and has no `status` filter.

Ordering is deterministic, ties always break on creation time then id, so pages never repeat or skip:
`sort=priority` (team queue default) is `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `UNSET`, oldest first
within a priority; `sort=age` (backlog default) is oldest first. A ticket leaves the backlog and enters
a team queue as soon as routing is approved, and moves between team queues on reassignment.

## Notifications

Any signed-in user reads and acknowledges **only their own** notifications. The recipient is always
the authenticated principal; nobody can name another user. A notification id that does not exist or
belongs to someone else is `404`. Notifications are created by ticket events (see
`docs/architecture.md`); there is no endpoint to create one.

| Method | Path                          | Purpose                                           |
| ------ | ----------------------------- | ------------------------------------------------- |
| GET    | `/api/notifications`          | Newest-first list with paging and `unreadCount`   |
| PATCH  | `/api/notifications/:id/read` | Mark one read (idempotent); returns `unreadCount` |
| POST   | `/api/notifications/read-all` | Mark all of the caller's notifications read       |

`GET` accepts `unreadOnly=true`, `limit` (1–100, default 20) and `offset`; unknown parameters are
`400`. It returns `{ items, total, limit, offset, nextOffset, unreadCount }`. `total` counts what the
filter matches, while `unreadCount` is always the caller's full unread total, so the two stay
consistent after a mark-read. Ordering is newest first with the id as tie-breaker, so pages never
repeat or skip. Each item has `id`, `type`, `message`, `ticketId`, `trackingId`, `ticketTitle`,
`read`, `readAt` and `createdAt`. `message` depends on `type` only and never contains comment or
internal-note text. Marking an already-read notification read again succeeds and keeps the first
`readAt`.

## Common status codes

- `400`: malformed or unexpected input.
- `401`: missing, invalid, or expired authentication.
- `403`: authenticated but not allowed to perform the operation.
- `404`: resource absent or deliberately hidden from the caller.
- `409`: uniqueness, idempotency, version, transition, or prerequisite conflict.
- `422`: semantically invalid workflow input.
- `429`: authentication rate limit exceeded.

Canonical payload types and validation limits live in `packages/contracts/src/index.ts`.

## Error shape and client mapping

Validation failures (`400`, or `422`) carry `details` as per-field messages, for example
`{ "title": ["Too long"] }` (`FieldErrors`). Domain conflicts (`409`) carry `details.code`
(`VERSION_CONFLICT`, `INVALID_TRANSITION`, `PREREQUISITE_FAILED`); clients branch on the code, never on
the message. The browser client (`frontend/src/lib/auth/client.ts`) turns every failure into one of two
classes, each with a stable `kind`:

| Situation                        | Thrown         | `kind`                                 |
| -------------------------------- | -------------- | -------------------------------------- |
| 401 after the single refresh try | `ApiError`     | `unauthenticated`                      |
| 403 / 404 / 409                  | `ApiError`     | `forbidden` / `not_found` / `conflict` |
| 400 or 422                       | `ApiError`     | `validation` (`fieldErrors` filled)    |
| 429 / 5xx                        | `ApiError`     | `rate_limited` / `server`              |
| No response / offline            | `NetworkError` | `network`                              |
| No response within 30 s          | `NetworkError` | `timeout`                              |

`ApiError.code` holds `details.code` and `ApiError.isVersionConflict` is true for a stale write. A request
cancelled through its own `AbortSignal` rethrows the `AbortError` and is not reported as a failure.

## Changing the contract

`packages/contracts` is the only source of transport types and request schemas; apps must not hand-write
a second copy of a field shape.

1. Change `packages/contracts/src/index.ts`. Request bodies are Zod schemas (`createTicketSchema`, ...)
   used by the backend to validate and by the frontend to pre-check; responses are interfaces.
2. List endpoints return `Paginated<T>`; do not invent another page shape.
3. Renaming or removing an export, or tightening a response field, is a breaking change: update the
   backend and frontend in the same pull request and refresh the export snapshot
   (`npm --prefix packages/contracts test -- -u`) so the change is visible in review.
4. Build it before the consumers compile (`npm --prefix packages/contracts run build`; Docker builds do
   this in `Dockerfile.dev`). If dependencies change, update each consumer's `package-lock.json`.
5. Keep the package browser-safe: no `node:*`, Prisma, Fastify or environment access.
   `npm --prefix frontend run check:bundle` fails the frontend CI when server-only packages or credential
   names reach the browser bundle.

Contract tests (`packages/contracts/test`) cover schema behaviour, the stable export list, and
`@ts-expect-error` cases that fail the typecheck if a DTO stops rejecting an incompatible shape.
