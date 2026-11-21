# Tickets API

Base path `/api/tickets`. Every response uses the common envelope `{ message, error, details, data }`.
Types live in `packages/contracts` (`TicketDto`, `CreateTicketRequest`).

## `POST /api/tickets` (SD-018)

Any signed-in user can submit a ticket for themselves. Anonymous callers get 401.

Request body (strict, so unknown fields are rejected with 400):

| Field         | Rules                                              |
| ------------- | -------------------------------------------------- |
| `title`       | string, trimmed, 1-150 characters                  |
| `description` | string, trimmed, nonblank, at most 5000 characters |

There is no other accepted metadata. The requester always comes from the access token, and
`role`, `requesterId`, `status`, `priority`, `categoryId`, `teamId` and `assigneeId` are rejected, so
an employee cannot set ownership or routing.

Optional header `Idempotency-Key` (8-100 printable ASCII characters, for example a UUID). See below.

Result: `201` with the ticket (`TicketDto`). The ticket is `OPEN`, priority `UNSET`, with no
category, team or assignee, and `version: 1`. `trackingId` equals `id` (a UUID). A `CREATED` event
is written in the same transaction, and 201 is only sent after the commit, so every 201 refers to a
persisted ticket and its audit event. Validation failure is 400; a database failure rolls both rows back.

Submission does not depend on AI. When an AI module exists it is scheduled after this commit and never
blocks or fails the request.

### Duplicate submits

- Same user, same `Idempotency-Key`, same title and description: `200` with the original ticket and
  header `Idempotent-Replay: true`. Nothing new is written.
- Same key with a different title or description: `409`.
- Keys are scoped per requester. Two simultaneous requests with one key create exactly one ticket.
- No key: every request creates a ticket. Clients that retry should send a key; the frontend (SD-023)
  generates one per form submission.

## Concurrency token

Tickets carry `version` (starts at 1, increments on every change). Endpoints that modify a ticket
take the version the client last read and answer 409 when it is stale; see
[concurrency](../database/concurrency.md).

## `GET /api/tickets` (SD-019)

Role-scoped history, newest first (`created_at DESC, ticket_id DESC`, a total order, so pages never
overlap or skip rows). Visibility is the same rule as the policies (`ticketReadFilter`), applied to
both the rows and the count:

| Role       | Sees                                                                  |
| ---------- | --------------------------------------------------------------------- |
| Employee   | only tickets they requested                                           |
| Technician | own requests, tickets of their active teams, and the unrouted backlog |
| Admin      | everything                                                            |

Query parameters (strict; unknown ones are 400):

| Name       | Rules                                                  |
| ---------- | ------------------------------------------------------ |
| `status`   | `OPEN`, `TRIAGED`, `IN_PROGRESS`, `RESOLVED`, `CLOSED` |
| `priority` | `UNSET`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`           |
| `limit`    | 1-100, default 20                                      |
| `offset`   | integer >= 0, default 0                                |

Result `TicketPage`: `items` (`TicketSummaryDto`, with category, team and assignee names already
joined, so there is no per-row lookup), `total` (rows visible with the filters), `limit`, `offset`
and `nextOffset` (null on the last page). Offset paging was chosen over cursors: `created_at` has
microsecond precision that a JavaScript cursor cannot carry exactly, and the total is wanted by the UI.
Tickets created while paging can shift later pages by one; they never cause an error.

## `GET /api/tickets/:id` (SD-019)

Returns `TicketDetailDto`: the approved fields, `version`, the requester, comments (oldest first)
and a role-specific timeline summary. Unknown, malformed and unreadable ids all return the same 404,
so ids cannot be probed.

| Data                 | Requester (and technician outside their scope)          | Staff in scope (technician, admin)       |
| -------------------- | ------------------------------------------------------- | ---------------------------------------- |
| Comments             | public only                                             | public and internal notes (`isInternal`) |
| Timeline event types | CREATED, STATUS_CHANGED, RESOLVED, REOPENED, TEAM_*     | all                                      |
| Timeline detail      | type and time; status changes show `from` and `to` only | actor and full structured `details`      |

AI recommendation data is not part of either view. The dedicated timeline endpoint (SD-022) will
refine which events requesters see.

## `POST /api/tickets/:id/transitions` (SD-020)

Moves a ticket along the workflow and writes the status change and its audit event in one
transaction. Body (strict):

| Field               | Rules                                                          |
| ------------------- | -------------------------------------------------------------- |
| `to`                | `OPEN`, `TRIAGED`, `IN_PROGRESS`, `RESOLVED` or `CLOSED`       |
| `expectedVersion`   | integer >= 1, **required**: the `version` the client last read |
| `resolutionSummary` | optional string, at most 5000; required for `RESOLVED`         |

Result: `200` with the updated `TicketDto` (new `version`). Errors:

| Status | `details.code`        | Meaning                                                                           |
| ------ | --------------------- | --------------------------------------------------------------------------------- |
| 400    |                       | malformed body, unknown field, missing `expectedVersion`                          |
| 401    |                       | not signed in                                                                     |
| 403    | `FORBIDDEN`           | caller can read the ticket but may not do this (e.g. the requester triaging)      |
| 404    |                       | unknown, malformed or unreadable id                                               |
| 409    | `VERSION_CONFLICT`    | stale `expectedVersion`; `details.currentVersion`. Reload and retry               |
| 409    | `INVALID_TRANSITION`  | no such edge; `details.from`, `details.to`                                        |
| 409    | `PREREQUISITE_FAILED` | `details.missing` lists `CATEGORY`, `PRIORITY`, `TEAM`, `ACTIVE_TEAM`, `ASSIGNEE` |
| 422    | `VALIDATION`          | blank resolution summary                                                          |

Checks run in this order: 404 and 403 (who you are), `VERSION_CONFLICT` (is your view current),
then the workflow. A failure of any kind leaves the ticket, its version and its events untouched;
nothing is corrected silently.

Allowed edges: OPEN→TRIAGED→IN_PROGRESS→RESOLVED→CLOSED and RESOLVED/CLOSED→OPEN. Anyone with work
access (admin; technician in scope) may take any edge; the requester may only reopen. Reopening
clears `resolved_at` and `resolution_summary`; earlier `RESOLVED` events stay in the timeline, and a
later resolve stamps a new `resolved_at`.

Routing (category, priority, team, assignee) is approved elsewhere (epic E04). Until then a ticket
that was never routed answers `PREREQUISITE_FAILED` to TRIAGED, which is the intended gate.
