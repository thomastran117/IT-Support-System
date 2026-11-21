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

## Support teams and reference data

Staff (`TECHNICIAN` or `ADMIN`) can read the reference lists that assignment forms need. Employees
receive `403`. These responses carry only what a dropdown needs: no emails, roles or account state.

| Method | Path                     | Purpose                                                    |
| ------ | ------------------------ | ---------------------------------------------------------- |
| GET    | `/api/teams`             | Active teams (`id`, `name`, `description`)                 |
| GET    | `/api/teams/:id/members` | Active technicians of an active team (`id`, `displayName`) |
| GET    | `/api/categories`        | Active ticket categories (`id`, `name`, `description`)     |

An inactive or unknown team returns `404` from the members list.

All `/api/admin/teams` endpoints require the `ADMIN` role.

| Method | Path                                   | Purpose                                                     |
| ------ | -------------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/admin/teams`                     | All teams, inactive included, with member counts            |
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
- Deactivating a team does not alter tickets already routed to it.

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

## Common status codes

- `400`: malformed or unexpected input.
- `401`: missing, invalid, or expired authentication.
- `403`: authenticated but not allowed to perform the operation.
- `404`: resource absent or deliberately hidden from the caller.
- `409`: uniqueness, idempotency, version, transition, or prerequisite conflict.
- `422`: semantically invalid workflow input.
- `429`: authentication rate limit exceeded.

Canonical payload types and validation limits live in `packages/contracts/src/index.ts`.
