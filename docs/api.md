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

## Common status codes

- `400`: malformed or unexpected input.
- `401`: missing, invalid, or expired authentication.
- `403`: authenticated but not allowed to perform the operation.
- `404`: resource absent or deliberately hidden from the caller.
- `409`: uniqueness, idempotency, version, transition, or prerequisite conflict.
- `422`: semantically invalid workflow input.
- `429`: authentication rate limit exceeded.

Canonical payload types and validation limits live in `packages/contracts/src/index.ts`.
