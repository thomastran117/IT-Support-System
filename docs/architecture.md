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
- **Worker** is the host for asynchronous work. It shares database and contract packages with the
  API and remains functional when the optional AI provider is disabled.
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
page explains that it can no longer be opened. Manual triage never depends on AI. The AI suggestion
card (accept, override, reject) arrives with the recommendation endpoints (SD-027, SD-036, SD-038).

## Development and validation

`docker compose up --build --watch` synchronizes application source. Shared-package, manifest, and
Prisma changes trigger image rebuilds so consumers always use compiled package output.

Compose profiles add one-shot services without affecting the normal stack:

- `ci`: formatting, backend/database/worker verification, and browser-enabled frontend tests.
- `tools`: generated documentation commands whose output is mounted back into the repository.

GitHub Actions invokes these same services rather than maintaining a separate host npm workflow.
