# SmartDesk

SmartDesk is a role-based IT support ticketing system with a Next.js web app, Fastify services,
and PostgreSQL. The Fastify gateway is the public API entry point in Docker Compose.

## Start the stack

Use Docker Desktop or Docker Engine with Docker Compose 2.24.4 or later.

```bash
docker compose up --build
```

Compose applies the PostgreSQL migrations and generates scoped database credentials and signing
keys before starting Ticket, Identity, Knowledge, Analytics, Notifications, and AI. The defaults
work without a `.env` file. Copy `.env.example` to `.env` to override ports, session settings,
logging, or provider configuration.

| Service             | Address or role                                         |
| ------------------- | ------------------------------------------------------- |
| Frontend            | <http://localhost:3000>                                 |
| API gateway         | <http://localhost:4000>                                 |
| Readiness           | <http://localhost:4000/health/ready>                    |
| PostgreSQL          | Internal only (`postgres:5432`)                         |
| Standalone services | Internal only                                           |
| AI analysis         | Disabled by default. Set `AI_PROVIDER=fake` for a demo. |

For a detached start that waits for readiness, use `docker compose up --build --wait`.
Add `--watch` to the foreground command for source sync and rebuilds. After adding a migration,
rerun `docker compose up --build` to apply it.

Stop the stack while preserving the database and generated service credentials.

```bash
docker compose down
```

## Seed demo data

Once the stack is ready, load the demo accounts and 300 sample tickets from a separate terminal.
Compose runs the seed in a one-off `local-bootstrap` container. The seed is safe to rerun.

```bash
docker compose run --rm --no-deps local-bootstrap npm run db:seed
```

See the [demo sign-in accounts](docs/authentication.md#demo-accounts).

## Upgrade or roll back a local stack

If the modular API and worker are already running, shut down that layout once with the same
project name and environment settings you used to start it. The standalone services will
then use its PostgreSQL volume.

```bash
docker compose -f docker-compose.modular.yml --profile '*' down
docker compose up --build
```

To roll back, run `docker compose --profile '*' down` and then
`docker compose -f docker-compose.modular.yml up --build` with the modular execution modes set
to `local`. For a direct API listener on the same port, add
`-f docker/compose.direct-api.yml` after the modular file argument.

## Configure standalone services

Set `AI_PROVIDER=fake` for deterministic recommendations, or set `AI_PROVIDER=openai` and
`AI_SERVICE_API_KEY` for OpenAI. The Notifications service handles the in-app inbox and can send
email when SMTP is configured. For a deployment with externally managed credentials, use the
[standalone deployment runbook](docs/architecture/ticket-service.md).

Run the full isolated demonstration from a fresh checkout with Docker Compose, Node.js, Git,
and a POSIX shell. The script provisions a disposable database, creates synthetic credentials,
and runs Chromium, the outage drills, and the rollback check.

```sh
SD100=1 SD100_PASSIVE_SCAN=1 sh docker/verify-ticket-service.sh
```

The run records scan and benchmark evidence in `test-results/sd100/`.
[Deliverable 1 traceability and evidence](docs/architecture/microservice-traceability.md)

## Common operations

```bash
# Follow one service
docker compose logs -f ticket-service

# Open PostgreSQL directly
docker compose exec postgres psql -U smartdesk -d smartdesk

# Apply pending migrations and service grants explicitly
docker compose run --rm --build local-bootstrap

# Regenerate the committed ERD and data dictionary
docker compose --profile tools run --rm docs

# Set REDIS_URL=redis://redis:6379 in .env, then start Redis and recreate its consumers
docker compose --profile cache up -d redis ticket-service identity-service
curl http://localhost:4000/health/ready

# Stop the cache and remove its ephemeral container
docker compose --profile cache rm --stop --force redis
```

Resetting the database is destructive:

```bash
docker compose down -v
docker compose up --build --wait
docker compose run --rm --no-deps local-bootstrap npm run db:seed
```

## Optional OpenSearch profile

Use the `search` profile with synthetic data for local development and CI. The single OpenSearch
node runs on an internal Compose network shared with Ticket and the search indexer. The frontend stays on
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
  -e OPENSEARCH_URL=http://opensearch:9200/ local-bootstrap npm run search:backfill -- --version 1
```

If `search:init` already created v1, backfill into version 2. Use `search:reindex` with a higher
version for later replacements. Add `--dry-run` after `--version N` to preview. Rerun the same
version after an interruption to resume. See the [rebuild runbook](docs/architecture.md#search-backfill-and-reindex).

To start indexing, set `OPENSEARCH_ENABLED=true` and `OPENSEARCH_URL=http://opensearch:9200/` in
`.env`, then run `docker compose --profile search up -d ticket-service search-indexer`. The
indexer consumes the PostgreSQL outbox. Ticket uses OpenSearch for text search and verifies
results against PostgreSQL. Knowledge serves standalone article search from PostgreSQL.

See the [search evaluation](docs/search-evaluation.md) for the authorization matrix, benchmark
results, and reproduction commands. The [offline hybrid knowledge experiment](docs/hybrid-knowledge-experiment.md)
compares the optional embedding approach with the published keyword path.

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
docker compose build gateway
docker compose run --rm --no-deps gateway npm test
sh docker/verify-service-containers.sh
sh docker/verify-default-compose.sh
```

`backend-ci` starts PostgreSQL, applies migrations, and runs package, API, worker, and database
checks. `frontend-ci` includes Chromium and runs unit plus desktop/mobile Playwright tests.
The service container script uses `jq` and creates a disposable Compose project.
GitHub runs the browser, service lifecycle, database, search, and scan jobs in parallel. The
required `backend / verify` and `frontend / verify` checks aggregate their respective job results.
The backend workflow runs the repository-wide format check once.

## Repository map

| Path                        | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `frontend/`                 | Next.js App Router UI                                                   |
| `backend/`                  | Fastify API, AI worker, Prisma schema/migrations, seeds, SQL reports    |
| `backend/gateway/`          | Fastify public API proxy                                                |
| `backend/services/`         | Separate AI, Identity, Knowledge, Analytics, and Notifications runtimes |
| `packages/contracts/`       | Browser-safe API types and validation                                   |
| `packages/db/`              | Generated Prisma client adapter shared by API and worker                |
| `packages/ai-analysis/`     | Provider adapters, proposal validation, and reusable runner             |
| `packages/service-runtime/` | Server-side environment validation shared by gateway and AI service     |
| `docs/`                     | Durable technical references and generated schema docs                  |

Each Node package owns its own manifest and lockfile. The root deliberately has no `package.json`,
`package-lock.json`, or npm workspace.

## Further reading

- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Authentication and authorization](docs/authentication.md)
- [Database development](docs/database.md)
- [Microservice traceability and verification](docs/architecture/microservice-traceability.md)

Never commit `.env` files, credentials, generated build output, or local test reports.
