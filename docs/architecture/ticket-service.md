# Isolated Ticket deployment

SD-098 adds a standalone Ticket entrypoint that runs the existing Fastify ticket, technician,
team, category, classification label, and audit handlers. It uses the same transaction and
query code for routing approval, human review, version checks, idempotency, and Q01–Q04.
The standard Compose file still provides the modular API and worker.

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

## Cutover

1. Apply Prisma migrations using the existing migration account and stage the service
   grants. Use the same Compose project and PostgreSQL volume for both deployment modes.
2. Set `TICKET_DATABASE_URL` to a login that inherits only `smartdesk_ticket`. Configure
   the separate Identity, Notifications, Knowledge, and Analytics database logins and
   service keys. Keep the browser session key, cookie settings, and allowed origin consistent
   across modes. Ticket needs its delegated Identity key and its own search cursor key.
   [Identity setup](identity-service.md), [Notifications setup](notifications-service.md),
   [Knowledge setup](knowledge-service.md), and [Analytics setup](analytics-service.md)
3. Stop the legacy backend, gateway, and worker, then start the isolated deployment.

```bash
docker compose stop backend gateway worker
docker compose -f docker-compose.yml -f docker/compose.ticket-service.yml up -d --build --wait
```

Enable the `services` profile with a configured AI provider and key to run independent AI.
For OpenSearch, enable the `search` profile, set `OPENSEARCH_ENABLED=true` and
`OPENSEARCH_URL`, and configure `SEARCH_DATABASE_URL` with a scoped search login.
Run index initialization and rebuilds with the maintenance account. Ticket can search
PostgreSQL during OpenSearch downtime. [OpenSearch indexes and aliases](../architecture.md#opensearch-indexes-and-aliases)

Verify ticket creation, the technician queue, routing and review, and the extracted
services through the gateway. Use the isolated overlay without the `legacy` profile
for serving traffic.

## Rollback

Stop the isolated deployment using the same profiles used for cutover. Keep the
PostgreSQL volume. Restore the legacy runtime's connection and session settings,
set its execution modes to `local`, and start the standard Compose configuration.
Jobs, audit events, tickets, and saved recommendations carry over in place.

```bash
docker compose -f docker-compose.yml -f docker/compose.ticket-service.yml --profile services --profile search down
docker compose up -d --build --wait
```

The Compose test exercises the real scoped Ticket login, manual routing during an
outage, AI completion and review, notification recovery, and the response contracts
after rollback. The database tests cover Q01–Q04 and index projections under their
respective roles. [Compose verification](../../docker/verify-ticket-service.sh)
