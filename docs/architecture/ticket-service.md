# Isolated Ticket deployment

SD-098 adds a standalone Ticket entrypoint that runs the existing Fastify ticket, technician,
team, category, classification label, and audit handlers. It uses the same transaction and
query code for routing approval, human review, version checks, idempotency, and Q01–Q04.
The default Compose stack runs the standalone Ticket service and provisions credentials locally.
Use the manual setup below when you manage database logins and signing keys separately.

The isolated Compose override gives the gateway an explicit owner for each route group.
Ticket owns ticket resources, reference data, technician queues, and ticket audit.
Identity owns sessions and account audit. Knowledge, Analytics, and Notifications serve
their existing route groups. Internal commands stay on the private API network, and
unregistered public paths return `404` in isolated mode.

Ticket verifies each user's access token through Identity and loads current memberships
from its own tables. The independent AI runner claims jobs and saves recommendations
through Ticket's authenticated commands, and retrieves articles through Knowledge.
Ticket checks publication through its restricted article metadata grant when it saves
citations. Ticket records notification intent in its source transaction. The Notifications
consumer can catch up after an outage. Manual ticket writes and human review use the
existing transaction paths while AI or Notifications is unavailable.
[Identity authority](identity-service.md) and [outbox delivery](service-outbox.md)

The optional search indexer gets a separate `smartdesk_search` login. It leases and
settles index jobs, reads Ticket's index projection fields, and loads published article
text and tombstone revisions from `smartdesk_search_article_sources`. Ticket and
Knowledge own the indexing intent created with their source changes.
[PostgreSQL grants](../database/service-access.md)

## Launch and verify a disposable stack

Run from the repository root with Node.js, Git, and Docker Compose with override tag support.
The verification script creates its own Compose project, migrates PostgreSQL, seeds test
accounts, and generates scoped logins and signing keys. It runs the browser and API journeys
with a deterministic AI provider, checks outages and rollback, and removes its project data.

```sh
SD100=1 SD100_PASSIVE_SCAN=1 sh docker/verify-ticket-service.sh
```

The same command runs in CI. The local reports include the tested revision, latency and resource
samples, and the passive scan under `test-results/sd100/`.
[Dynamic analysis and prerequisites](../testing/microservice-dynamic-analysis.md)

## Prepare a persistent Compose project

Create an untracked `.env.isolated` from `.env.example`. Use the same project name, environment
file, host ports, and PostgreSQL volume throughout migration and rollback. For an existing
installation, substitute its current project name and environment file in the functions below.
The SQL commands use the example's `smartdesk` database and migration owner.

```sh
project=smartdesk-isolated
legacy() { docker compose -p "$project" --env-file .env.isolated -f docker-compose.modular.yml "$@"; }
isolated() { legacy -f docker/compose.ticket-service.yml --profile services "$@"; }
db_owner() { legacy exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk "$@"; }

legacy up -d --wait postgres
legacy run --rm --build --no-deps backend npm run migrate
# Seed synthetic accounts when preparing a new demo database.
legacy run --rm --no-deps backend npm run db:seed -- --profile demo
db_owner < backend/sql/service-access/roles.sql
db_owner < backend/sql/service-access/enable.sql
```

For each runtime, provision a separate PostgreSQL login that inherits only its service role.
The migration owner retains schema changes and privileged search rebuilds.
[Owner and grant configuration](../database/service-access.md#apply-on-an-existing-database)

| Connection setting           | Group inherited by its login                   |
| ---------------------------- | ---------------------------------------------- |
| `TICKET_DATABASE_URL`        | `smartdesk_ticket`                             |
| `IDENTITY_DATABASE_URL`      | `smartdesk_identity`                           |
| `KNOWLEDGE_DATABASE_URL`     | `smartdesk_knowledge`                          |
| `ANALYTICS_DATABASE_URL`     | `smartdesk_analytics`                          |
| `NOTIFICATIONS_DATABASE_URL` | `smartdesk_notifications`                      |
| `SEARCH_DATABASE_URL`        | `smartdesk_search` when the indexer is enabled |

The connection strings use `postgres:5432` inside the Compose network. Keep the legacy
`JWT_SECRET` and isolated `IDENTITY_JWT_SECRET` aligned with the same issuer, audience, cookie
settings, and frontend origin. Configure a separate, random `TICKET_SEARCH_CURSOR_SECRET`.

Give each internal caller a distinct P-256 PKCS#8 key. Configure its key ID and private key
with the named settings, and put its matching SPKI public key and grants in the receiving
registry. Keep the private values in the untracked environment file.
[Registry entry format and rotation](../authentication.md#configure-and-rotate-keys)

Generate the key pair for each row with a distinct basename. The Ticket pair is shown here.

```sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out .env.ticket-key.pem
openssl pkey -in .env.ticket-key.pem -pubout -out .env.ticket-public.pem
```

| Caller                     | Key settings                                            | Registry and grant                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket                     | `TICKET_IDENTITY_KEY_ID`, `TICKET_IDENTITY_PRIVATE_KEY` | `INTERNAL_SERVICE_KEYS`, service `ticket`, `identity:ticket-principal` user grant                                                                                                                                                                                                           |
| Knowledge                  | `KNOWLEDGE_KEY_ID`, `KNOWLEDGE_PRIVATE_KEY`             | `INTERNAL_SERVICE_KEYS`, service `knowledge`, `identity:knowledge-principal` user grant                                                                                                                                                                                                     |
| Analytics                  | `ANALYTICS_KEY_ID`, `ANALYTICS_PRIVATE_KEY`             | `INTERNAL_SERVICE_KEYS`, service `analytics`, `identity:analytics-principal` user grant                                                                                                                                                                                                     |
| Notifications              | `NOTIFICATIONS_KEY_ID`, `NOTIFICATIONS_PRIVATE_KEY`     | `INTERNAL_SERVICE_KEYS`, service `notifications`, `identity:notification-recipient` user grant                                                                                                                                                                                              |
| AI with an active provider | `AI_SERVICE_KEY_ID`, `AI_SERVICE_PRIVATE_KEY`           | `INTERNAL_SERVICE_KEYS`, service `ai`, system grants `ticket:analysis-claim`, `ticket:analysis-inputs`, `ticket:analysis-complete`, `ticket:analysis-fail`. Add the same public key under service `ai` with the `knowledge:published-retrieval` system grant in `KNOWLEDGE_RETRIEVAL_KEYS`. |

Use `AI_PROVIDER=fake` for a deterministic demo with AI, or `AI_PROVIDER=none` for manual ticketing.
The overlay selects the isolated routes and execution modes.

## Cut over, inspect, and stop

```bash
legacy stop backend gateway worker
isolated config --services
isolated up -d --build --wait
isolated ps
curl --fail http://localhost:4000/health/ready
isolated logs --tail 50 gateway ticket-service identity-service
```

For OpenSearch, enable the `search` profile, set `OPENSEARCH_ENABLED=true` and
`OPENSEARCH_URL`, and configure `SEARCH_DATABASE_URL` with a scoped search login.
Run index initialization and rebuilds with the maintenance account. Ticket can search
PostgreSQL during OpenSearch downtime. [OpenSearch indexes and aliases](../architecture.md#opensearch-indexes-and-aliases)

For a fresh index, start OpenSearch and backfill generation 1 before starting the search indexer.

```sh
isolated --profile search up -d --wait --wait-timeout 180 opensearch
legacy run --rm --no-deps backend npm run search:backfill -- --version 1
isolated --profile search up -d --build --wait
```

Sign in through the frontend, submit a ticket, route it from the technician queue, and verify
its audit and notification. With AI enabled, open the proposal and record a review. Use
`isolated stop` to stop the active services while leaving the containers and data in place.
Include any additional profiles you enabled in the stop command.

## Rollback

Stop the isolated deployment using the same profiles used for cutover. Keep the
PostgreSQL volume. Restore the legacy runtime's connection and session settings,
set its execution modes to `local`, and start the modular Compose configuration.
Jobs, audit events, tickets, and saved recommendations carry over in place.

```bash
isolated --profile search down
AI_EXECUTION_MODE=local IDENTITY_EXECUTION_MODE=local KNOWLEDGE_EXECUTION_MODE=local \
  ANALYTICS_EXECUTION_MODE=local NOTIFICATIONS_EXECUTION_MODE=local legacy up -d --build --wait
curl --fail http://localhost:4000/health/ready
```

The Compose test exercises the real scoped Ticket login, manual routing during an
outage, AI completion and review, notification recovery, and the response contracts
after rollback. The database tests cover Q01–Q04 and index projections under their
respective roles. [Compose verification](../../docker/verify-ticket-service.sh)
