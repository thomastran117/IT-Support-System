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
