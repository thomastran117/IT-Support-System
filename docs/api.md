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

| Method | Path                     | Purpose                                                                                         |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/teams`             | Active teams (`id`, `name`, `description`); `?mine=true` limits a technician to their own teams |
| GET    | `/api/teams/:id/members` | Active technicians of an active team (`id`, `displayName`)                                      |
| GET    | `/api/categories`        | Active ticket categories (`id`, `name`, `description`)                                          |

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
- Uses PostgreSQL full-text search with the `english` configuration (stemming, stop words, case
  and punctuation folded) over title and body, via a partial GIN index on published rows
  (`idx_knowledge_articles_fts`, migration `0007`). The query is `websearch_to_tsquery`: quoted
  phrases, `or` and `-term` work, and anything else is treated as plain text. It is always a bound
  parameter, so injection-like input is just data.
- Order: weighted relevance (a title match outranks a body-only match), then most recently
  updated, then id, so the order is total and stable across pages.
- Drafts and unpublished articles are never candidates. The endpoint and future AI retrieval share
  one repository function (`searchPublished`), so there is no second search path.
- An unknown `categoryId` yields an empty page. Changing the language means rebuilding the index
  and the matching expression in `backend/src/db/repositories/knowledge.ts`.

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

## Common status codes

- `400`: malformed or unexpected input.
- `401`: missing, invalid, or expired authentication.
- `403`: authenticated but not allowed to perform the operation.
- `404`: resource absent or deliberately hidden from the caller.
- `409`: uniqueness, idempotency, version, transition, or prerequisite conflict.
- `422`: semantically invalid workflow input.
- `429`: authentication rate limit exceeded.

Canonical payload types and validation limits live in `packages/contracts/src/index.ts`.
