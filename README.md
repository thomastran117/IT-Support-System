# SmartDesk

IT support ticketing system. npm-workspaces monorepo with two independently runnable apps, a worker and a shared TypeScript contract package.

| Workspace              | Path                  | Purpose                                    |
| ---------------------- | --------------------- | ------------------------------------------ |
| `@smartdesk/frontend`  | `frontend/`           | Next.js (App Router) + Tailwind            |
| `@smartdesk/backend`   | `backend/`            | Fastify HTTP API, migrations               |
| `@smartdesk/worker`    | `worker/`             | Background worker                          |
| `@smartdesk/contracts` | `packages/contracts/` | Browser-safe shared types (no server code) |

## Prerequisites

- Node.js 22+ (see `.nvmrc`) and npm 10+ — npm is the only package manager used.
- Docker with Compose v2 (for the containerised environment and PostgreSQL).

## Quick start (host)

```bash
cp .env.example .env     # development placeholders only, no secrets
npm ci
npm run build -w packages/contracts -w packages/db   # also runs `prisma generate`
npm run dev --workspace backend    # http://localhost:4000
npm run dev --workspace frontend   # http://localhost:3000 (starts without the API)
```

The backend needs PostgreSQL for `/health/ready`; `/health/live` works without it.
Run everything at once with `npm run dev`.

## Root scripts

| Command             | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | backend + worker + frontend together              |
| `npm run build`     | builds contracts first, then every workspace      |
| `npm run lint`      | lint in every workspace (fails if any fails)      |
| `npm run typecheck` | typecheck in every workspace (fails if any fails) |
| `npm test`          | tests in every workspace                          |
| `npm run format`    | Prettier write (`format:check` verifies)          |

Run one workspace with `npm run <script> --workspace <frontend|backend|worker|packages/contracts>`.

## Docker Compose

```bash
cp .env.example .env
docker compose up --build        # postgres, backend, worker, frontend
docker compose logs -f backend   # follow logs of a service
docker compose down              # stop, keep data (named volume `pgdata`)
```

- Frontend: <http://localhost:3000> · API: <http://localhost:4000> (`/health/live`, `/health/ready`)
- PostgreSQL sits on an isolated internal network and is not published on the host. Backend/worker reach it as `postgres:5432`. Ad-hoc access: `docker compose exec postgres psql -U smartdesk`.
- The backend applies migrations on start. Re-run manually: `docker compose exec backend npm run migrate -w backend`; seed demo data: `docker compose exec backend npm run seed -w backend`.
- **Destructive reset** (deletes all data, rebuilds schema and seed):

  ```bash
  docker compose down -v
  docker compose up --build -d
  docker compose exec backend npm run seed -w backend
  ```

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, using the Node version from `.nvmrc` with npm caching. Job `verify` runs, in order:

`npm ci` → `npm run format:check` → `npm run lint` → `npm run typecheck` → `npm run build` → `npm run migrate -w backend` (`prisma migrate deploy`, fresh PostgreSQL 16 service) → `npm test` (including the migration integration test).

Environment variables (all CI-only, non-secret, set in the workflow): `DATABASE_URL`, `TEST_DATABASE_URL`, `FRONTEND_ORIGIN`, `NEXT_PUBLIC_API_URL`. No repository secrets are used. Logs are uploaded as the `ci-logs` artifact on failure.

**Required before merge:** the `verify` check (configure it as a required status check in branch protection for `main`).

Reproduce locally against a database: `TEST_DATABASE_URL=postgres://… npm test`.

## Conventions

- Shared types live in `packages/contracts` and must stay browser-safe (no `node:*`, `pg`, `fastify`).
- API responses use the envelope `{ message, error, details, data }`.
- Feature code never hardcodes API hosts; the frontend reads `NEXT_PUBLIC_API_URL` via `frontend/src/lib/config.ts`.
- Database access goes through Prisma (`@smartdesk/db`). Edit `packages/db/prisma/schema.prisma`, then `npm run migrate:dev -w @smartdesk/db -- --name <change>` to create a migration; commit the generated SQL. The generated client (`packages/db/src/generated`) is not committed.
- Never commit `.env` files or build output.
