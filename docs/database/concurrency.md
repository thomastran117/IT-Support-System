# Transactions and concurrency

Implemented in `backend/src/db/` (SD-008). Tests: `backend/test/integration/transactions.integration.test.ts`
and `backend/test/unit/db/errors.test.ts`.

## Client lifecycle

- `initPrisma(url)` creates one Prisma client (one `pg` pool) per process; `getPrisma()` returns it;
  `closePrisma()` drains it and is safe to call twice. The API calls it at startup and in its
  SIGINT/SIGTERM handler. The worker is a separate process with its own module-level client and
  already disconnects on shutdown. No request ever creates a client.

## Transaction boundary

`withTransaction(prisma, work, options)`:

- bounded duration: `timeoutMs` (default 10 s) and `maxWaitMs` for a pooled connection (default 5 s);
- retries serialization failures (`40001`) and deadlocks (`40P01`) up to `retries` (default 2) with
  jittered backoff;
- always rethrows a safe `DbError`.

Services in `services/ticketService.ts`, each a single transaction:

| Operation                       | Writes that commit together                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `createTicket` / `submitTicket` | `tickets` (OPEN/UNSET, optional idempotency key) + `CREATED` event                             |
| `approveRouting`                | approved category/priority/team/assignee (+ OPEN→TRIAGED when complete) + one event per change |
| `reviewRecommendation`          | review metadata + approved ticket values + routing events + `AI_REVIEWED`                      |
| `addComment`                    | comment + `COMMENT_ADDED` (details carry ids only, never the text)                             |
| `transitionTicket`              | status/resolution fields + `STATUS_CHANGED` / `RESOLVED` / `REOPENED`                          |

Notification intent (item e of the issue) is added with SD-040 inside the same boundary.

Event rules: the first non-null team uses `TEAM_ASSIGNED`; any later team change uses
`TEAM_REASSIGNED`. Unapproved AI suggestions never write events or ticket columns: only
`reviewRecommendation` (a technician decision) does. `ai_recommendations.proposed_*`, `suggestion` and
`confidence` are never in an UPDATE; only `review_status`, `reviewer_id`, `reviewed_at`,
`review_notes` change. `occurred_at`/`resolved_at`/`reviewed_at` use the database clock
(`clock_timestamp()`), so events in one transaction stay ordered and the `>= created_at` CHECKs hold
even with clock skew between app and database.

## Concurrency strategy

**Optimistic concurrency (since SD-018/SD-020).** No ticket write holds a row lock while it thinks;
every write is conditional on the `version` that was read.

- `tickets.version` starts at 1 and every ticket mutation increments it (`patchTicketIfVersion`,
  `markResolved`). The API returns it as `version` on every ticket payload.
- A mutation reads the ticket, decides, then writes with `UPDATE ... WHERE ticket_id = $id AND
version = $read`. Zero rows changed means someone else got there first: the whole transaction
  (status change and audit events) rolls back and the caller gets `VERSION_CONFLICT` (HTTP 409,
  `details.currentVersion`). Nothing is overwritten and no event is orphaned. Under READ COMMITTED a
  second writer waits for the first to commit, re-evaluates the `WHERE` and matches nothing.
- **Callers that name a version** (`expectedVersion`, mandatory on `POST /api/tickets/:id/transitions`)
  are never retried: their view is stale and must be reloaded. A stale version is reported before
  any workflow error, so the client refreshes first.
- **Callers that name none** (internal service calls with no stale view to protect) retry the whole
  transaction on a lost race, up to 8 attempts with jittered backoff (`mutate` in
  `ticketService.ts`), so concurrent system writers still all land without losing events.
- Duplicate submits use the same idea: `tickets(requester_id, idempotency_key)` is unique, so two
  racing requests with one key cannot both insert; the loser rolls back and returns the winner's
  ticket (`submitTicket`).
- A recommendation is claimed by `UPDATE ... WHERE review_status = 'PENDING'`; the reviewer who
  matches no row gets `STALE_WRITE`, so two reviewers cannot both decide it.
- `lockRow` (`SELECT ... FOR UPDATE`) and `expectedUpdatedAt` are gone. Millisecond JavaScript dates
  could differ from the microsecond `updated_at`, which made them an unreliable token.

Lock-free also removes the lock-ordering rule: transactions touch the recommendation and the
ticket in any order without deadlock risk (the retry loop still covers serialization failures).

## Error mapping

`mapDbError` converts any failure into a `DbError` whose message is safe to return:

| Cause                           | Code                                                                                                                                                                                 | HTTP |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| unique violation (23505)        | `CONFLICT`                                                                                                                                                                           | 409  |
| FK / restrict (23503, 23001)    | `REFERENCE`                                                                                                                                                                          | 409  |
| CHECK / NOT NULL (23514, 23502) | `CONSTRAINT`                                                                                                                                                                         | 422  |
| serialization / deadlock        | `RETRYABLE` (after retries)                                                                                                                                                          | 409  |
| transaction timeout             | `TIMEOUT`                                                                                                                                                                            | 503  |
| database unreachable            | `UNAVAILABLE`                                                                                                                                                                        | 503  |
| anything else                   | `UNKNOWN` ("Internal server error")                                                                                                                                                  | 500  |
| service-level                   | `VALIDATION` 422, `FORBIDDEN` 403, `NOT_FOUND` 404, `LIFECYCLE` 409, `STALE_WRITE` 409 (recommendation), `VERSION_CONFLICT` 409, `INVALID_TRANSITION` 409, `PREREQUISITE_FAILED` 409 |      |

Messages never include SQL, constraint names, connection strings or row data. The API puts the
code in `details.code` of the error envelope so clients branch on it, never on the message.

## Authorization

Services re-read the acting user (must exist and be active) and derive the role from the database,
never from client input. Staff scope is the shared policy `canEditTicket` (`auth/policies.ts`), the
same rule the HTTP layer applies: admins act on any ticket; technicians on tickets of their **active**
teams and on the unrouted backlog, but only while they belong to at least one active team (a
technician with no active team is denied, in the service as well as at the API). Employees act only
on their own tickets and cannot write internal notes; the requester may reopen their own ticket.
Target team/category must be active; an assignee must be an active technician in the assigned team
(the composite FK from SD-007 remains as defence in depth).

## Allowed transitions

The workflow lives in `backend/src/domain/ticketStateMachine.ts` (pure, unit-tested for all 25
status pairs). OPEN→TRIAGED→IN_PROGRESS→RESOLVED→CLOSED, and RESOLVED/CLOSED→OPEN (reopen clears
`resolved_at` and `resolution_summary`; earlier `RESOLVED` events stay in the audit trail). TRIAGED
and IN_PROGRESS require an approved category, a priority other than UNSET, an assigned **active** team
and, when set, an assignee who is an active technician in that team. RESOLVED requires a nonblank
summary; CLOSED keeps the existing one unless a new one is supplied.
