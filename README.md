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

| Service    | Address or role                                                               |
| ---------- | ----------------------------------------------------------------------------- |
| Frontend   | <http://localhost:3000>                                                       |
| API        | <http://localhost:4000>                                                       |
| Liveness   | <http://localhost:4000/health/live>                                           |
| Readiness  | <http://localhost:4000/health/ready>                                          |
| PostgreSQL | Internal Compose network only (`postgres:5432`)                               |
| Worker     | Internal background process; no published endpoint                            |
| Redis      | Optional cache, off by default (`docker compose --profile cache up -d redis`) |

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

# Start the optional Redis cache (off by default), then point the backend at it
docker compose --profile cache up -d redis
# set REDIS_URL=redis://redis:6379 in .env (the in-network service name, not localhost), then:
docker compose up -d backend
curl http://localhost:4000/health/ready   # checks.cache: "ok" | "unavailable" | "disabled"

# Stop and fully dispose of the cache -- it has no persistence, so nothing survives
docker compose stop redis && docker compose rm -f redis
```

Resetting the database is destructive:

```bash
docker compose down -v
docker compose up --build --watch
docker compose exec backend npm run db:seed
```

## Optional OpenSearch profile

Use the `search` profile with synthetic data for local development and CI. The single OpenSearch
node runs on an internal Compose network shared with the API and worker. The frontend stays on
the public network. The search node publishes no host ports and the application starts with search
disabled.

Allow 1.5 GiB of additional Docker memory, including a 512 MiB JVM heap. The `opensearch-data`
volume uses Docker disk space as indexes grow. On Linux, verify the host's `vm.max_map_count` is at
least `262144`. With Docker Desktop on Windows using WSL, check the Docker Desktop WSL distribution.
See the [OpenSearch Docker setup guide](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/)
for the platform-specific commands.

```bash
docker compose --profile search up --wait --wait-timeout 180 opensearch
docker compose --profile search ps opensearch
docker compose --profile search logs opensearch
docker compose --profile search stop opensearch
```

Run the first command again to restart and reuse the volume. To tear down the full stack while
preserving both volumes, run `docker compose --profile search down`. If the node fails to start,
check its logs, available Docker memory and disk, and `vm.max_map_count`. To reset a disposable
search volume, remove the search container with `docker compose --profile search rm --stop --force opensearch`.
List candidate volumes with `docker volume ls --filter label=com.docker.compose.volume=opensearch-data`,
then use `docker volume rm` with the exact search volume name for this project. PostgreSQL data is
stored in `pgdata`. OpenSearch holds a derived projection that can be rebuilt from PostgreSQL.

After PostgreSQL migrations are applied and OpenSearch is healthy, build the first generation:

```bash
docker compose --profile search run --rm --build --no-deps -e OPENSEARCH_ENABLED=true \
  -e OPENSEARCH_URL=http://opensearch:9200/ backend npm run search:backfill -- --version 1
```

If `search:init` already created v1, backfill into version 2. Use `search:reindex` with a higher
version for later replacements. Add `--dry-run` after `--version N` to preview. Rerun the same
version after an interruption to resume. See the [rebuild runbook](docs/architecture.md#search-backfill-and-reindex).

To start indexing, set `OPENSEARCH_ENABLED=true` and `OPENSEARCH_URL=http://opensearch:9200/` in
`.env`, then run `docker compose up -d worker`. The worker consumes the PostgreSQL outbox. The
ticket and knowledge endpoints currently read from PostgreSQL.

For production, use a separate secured OpenSearch deployment with verified TLS, private network
access, and least-privilege service accounts. Inject `OPENSEARCH_USERNAME` and `OPENSEARCH_PASSWORD`
into the backend and worker through deployment secrets when enabling search there. Keep those
values out of source control and browser configuration. See the [OpenSearch security guide](https://docs.opensearch.org/latest/security/configuration/best-practices/).

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

| Path                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `frontend/`           | Next.js App Router UI                                                |
| `backend/`            | Fastify API, AI worker, Prisma schema/migrations, seeds, SQL reports |
| `packages/contracts/` | Browser-safe API types and validation                                |
| `packages/db/`        | Generated Prisma client adapter shared by API and worker             |
| `docs/`               | Durable technical references and generated schema docs               |

Each Node package owns its own manifest and lockfile. The root deliberately has no `package.json`,
`package-lock.json`, or npm workspace.

## Further reading

- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Authentication and authorization](docs/authentication.md)
- [Database development](docs/database.md)

Never commit `.env` files, credentials, generated build output, or local test reports.
