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
- The backend applies migrations on start. Re-run manually: `docker compose exec backend npm run migrate -w backend`; seed demo data: `docker compose exec backend npm run db:seed -w backend`.
- **Destructive reset** (deletes all data, rebuilds schema and seed):

  ```bash
  docker compose down -v
  docker compose up --build -d
  docker compose exec backend npm run db:seed -w backend
  ```

## Continuous integration

Two GitHub Actions workflows run on every push to `main` and every pull request, using the Node version from `.nvmrc` with npm caching. Both start with `npm ci` and `npm run format:check`.

| Workflow (`.github/workflows/`) | Required check      | Steps after install                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend.yml`                   | `backend / verify`  | build contracts + Prisma client, lint, typecheck, build (backend, worker, db, contracts); **unit tests** (`npm run test:unit -w backend`); worker tests; `npm run migrate -w backend` on a fresh PostgreSQL 16 service; **integration tests** (`npm run test:integration -w backend`) |
| `frontend.yml`                  | `frontend / verify` | lint, typecheck, **unit tests** (`npm run test:unit -w frontend`), Playwright browser install, **end-to-end tests** (`npm run test:e2e -w frontend`, builds and serves the app; desktop and mobile Chromium)                                                                          |

Environment variables (CI-only, non-secret, set in the workflows): `DATABASE_URL`, `TEST_DATABASE_URL`, `FRONTEND_ORIGIN` (backend); `NEXT_PUBLIC_API_URL` (frontend). No repository secrets are used. Logs (and the Playwright report) are uploaded as artifacts on failure.

Mark both `backend / verify` and `frontend / verify` as required status checks in branch protection for `main`. The workflows have no path filters so required checks always report.

Test layout: `backend/test/unit` (no external services), `backend/test/integration` (needs `TEST_DATABASE_URL`, skipped without it), `frontend/test/unit` (Vitest), `frontend/e2e` (Playwright). Locally: `npx playwright install chromium` once, then `npm run test:e2e -w frontend`. Root `npm test` runs unit/integration suites but not Playwright.

## Conventions

- Shared types live in `packages/contracts` and must stay browser-safe (no `node:*`, `pg`, `fastify`).
- API responses use the envelope `{ message, error, details, data }`.
- Feature code never hardcodes API hosts; the frontend reads `NEXT_PUBLIC_API_URL` via `frontend/src/lib/config.ts`.
- Database access goes through Prisma (`@smartdesk/db` exports the client; the schema and migrations live in `backend/prisma/`). Edit `backend/prisma/schema.prisma`, then `npm run migrate:dev -w backend -- --name <change>` to create a migration; commit the generated SQL. Constraints Prisma cannot express go in hand-written SQL migrations. The generated client (`packages/db/src/generated`) is not committed. Deviations from the Deliverable 2 design are recorded in `docs/database/deviations.md`.
- **Database docs, seed and tests:** see [docs/database/](docs/database/README.md) (ERD, data dictionary, query catalogue, fixtures). Common commands: `npm run db:migrate`, `npm run db:seed`, `TEST_DATABASE_URL=� npm run test:db` (fresh isolated database per run), `npm run docs:db` (regenerate the ERD and dictionary from `docs/database/schema-spec.json`).
- Never commit `.env` files or build output.
