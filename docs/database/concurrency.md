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

**Direction (SD-018 onwards): optimistic concurrency.** Prefer a version check over holding locks.

- `tickets.version` starts at 1 and every ticket mutation increments it (`patchTicket`,
  `markResolved`). The API returns it as `version` on every ticket payload.
- A writer sends the version it read. The write is a conditional `UPDATE ... WHERE version = $n`;
  zero matching rows means someone else changed the ticket, and the caller gets a 409 to reload and
  retry. Nothing is silently overwritten. The state-machine endpoint (SD-020) is the first to take
  `expectedVersion`; it replaces `expectedUpdatedAt` below.
- Duplicate submits use the same idea: `tickets(requester_id, idempotency_key)` is unique, so two
  racing requests with one key cannot both insert. The loser's transaction rolls back and it returns
  the winner's ticket (`submitTicket`). No lock is taken.

**Existing services (not yet converted):** `approveRouting`, `transitionTicket` and
`reviewRecommendation` still use the earlier scheme, which SD-020 migrates:

1. Every mutation locks the ticket with `SELECT … FOR UPDATE` (`lockRow`) before reading it, so
   concurrent writers to one ticket run one after another and each sees the previous commit.
   Lock order is always **ticket, then recommendation**, so reviews cannot deadlock.
2. Callers may pass `expectedUpdatedAt` (the version they last read). If the locked row differs, the
   operation fails with `STALE_WRITE` (HTTP 409) instead of silently overwriting. Millisecond
   JavaScript dates can differ from the microsecond column, which is why `version` replaces it.
3. A recommendation that is no longer `PENDING` when its lock is acquired also fails with
   `STALE_WRITE`, so two reviewers cannot both decide it.

## Error mapping

`mapDbError` converts any failure into a `DbError` whose message is safe to return:

| Cause                           | Code                                                                                   | HTTP |
| ------------------------------- | -------------------------------------------------------------------------------------- | ---- |
| unique violation (23505)        | `CONFLICT`                                                                             | 409  |
| FK / restrict (23503, 23001)    | `REFERENCE`                                                                            | 409  |
| CHECK / NOT NULL (23514, 23502) | `CONSTRAINT`                                                                           | 422  |
| serialization / deadlock        | `RETRYABLE` (after retries)                                                            | 409  |
| transaction timeout             | `TIMEOUT`                                                                              | 503  |
| database unreachable            | `UNAVAILABLE`                                                                          | 503  |
| anything else                   | `UNKNOWN` ("Internal server error")                                                    | 500  |
| service-level                   | `VALIDATION` 422, `FORBIDDEN` 403, `NOT_FOUND` 404, `LIFECYCLE` 409, `STALE_WRITE` 409 |      |

Messages never include SQL, constraint names, connection strings or row data.

## Authorization

Services re-read the acting user (must exist and be active) and derive the role from the database,
never from client input. Employees act only on their own tickets and cannot write internal notes;
technicians act on unassigned tickets and on tickets of teams they belong to; admins on any. Target
team/category must be active; an assignee must be an active technician in the assigned team (the
composite FK from SD-007 remains as defence in depth).

## Allowed transitions

`ALLOWED_TRANSITIONS` (exported for the ticket state machine, SD-020): OPEN→TRIAGED→IN_PROGRESS→
RESOLVED→CLOSED, and RESOLVED/CLOSED→OPEN (reopen clears `resolved_at` and `resolution_summary`;
earlier `RESOLVED` events stay in the audit trail).
