# SmartDesk

SmartDesk is a role-based IT support ticketing system with a Next.js web app, Fastify API,
PostgreSQL database, and background worker. Docker Compose is the supported development and
validation environment; no root npm installation is required.

## Start the stack

Prerequisite: Docker Desktop or Docker Engine with Compose v2 and Compose Watch support.

```bash
docker compose up --build --watch
```

The defaults work without a `.env` file. Copy `.env.example` to `.env` only when you need to
override ports, credentials, token lifetimes, logging, or the optional AI provider.

| Service    | Address or role                                    |
| ---------- | -------------------------------------------------- |
| Frontend   | <http://localhost:3000>                            |
| API        | <http://localhost:4000>                            |
| Liveness   | <http://localhost:4000/health/live>                |
| Readiness  | <http://localhost:4000/health/ready>               |
| PostgreSQL | Internal Compose network only (`postgres:5432`)    |
| Worker     | Internal background process; no published endpoint |

Application source changes are synchronized into the running frontend, backend, and worker.
Changes to manifests, lockfiles, Prisma files, or shared packages rebuild the affected images.

Stop the stack while preserving database data:

```bash
docker compose down
```

## Common operations

```bash
# Follow one service
docker compose logs -f backend

# Seed or refresh the deterministic demo records
docker compose exec backend npm run db:seed

# Open PostgreSQL directly
docker compose exec postgres psql -U smartdesk -d smartdesk

# Apply pending migrations explicitly (the backend also does this on startup)
docker compose exec backend npm run migrate

# Regenerate the committed ERD and data dictionary
docker compose --profile tools run --rm docs
```

Resetting the database is destructive:

```bash
docker compose down -v
docker compose up --build --watch
docker compose exec backend npm run db:seed
```

## Validation

The same container targets run locally and in GitHub Actions:

```bash
docker compose --profile ci run --rm format-check
docker compose --profile ci run --rm backend-ci
docker compose --profile ci run --rm frontend-ci
```

`backend-ci` starts PostgreSQL, applies migrations, and runs package, API, worker, and database
checks. `frontend-ci` includes Chromium and runs unit plus desktop/mobile Playwright tests.

## Repository map

| Path                  | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| `frontend/`           | Next.js App Router UI                                     |
| `backend/`            | Fastify API, Prisma schema/migrations, seeds, SQL reports |
| `worker/`             | Background processing host                                |
| `packages/contracts/` | Browser-safe API types and validation                     |
| `packages/db/`        | Generated Prisma client adapter shared by API and worker  |
| `docs/`               | Durable technical references and generated schema docs    |

Each Node package owns its own manifest and lockfile. The root deliberately has no `package.json`,
`package-lock.json`, or npm workspace.

## Further reading

- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Authentication and authorization](docs/authentication.md)
- [Database development](docs/database.md)

Never commit `.env` files, credentials, generated build output, or local test reports.
