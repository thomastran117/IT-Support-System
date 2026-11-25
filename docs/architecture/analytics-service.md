# Independent Analytics service

SD-095 moves `GET /api/admin/reports/summary` and `GET /api/admin/reports/ai-evaluation`
to an independent Fastify process. Both execution modes use the Q05–Q14 SQL in
`packages/analytics/sql` and the same route code for window parsing and response formatting.

Analytics reads committed Ticket facts directly using the `smartdesk_analytics` column
grants. Those grants cover cohort and timing fields, reference categories, recommendation
and review metadata, and the account fields needed to verify an active admin. Ticket owns
the facts and serves classification label writes. The independent service queries PostgreSQL
on every request. Local mode retains the existing 30-second Redis cache for report fragments.
[PostgreSQL access](../database/service-access.md)

Analytics sends Identity a short-lived signed credential bound to the browser's access token.
Identity verifies the token against the current account and returns the user's ID and role.
Analytics requires `ADMIN` and rechecks the active role in the report queries. The gateway
forwards report paths to the private Analytics listener in service mode. Ticket routes and
gateway readiness continue to use the backend during an Analytics outage.
[Service authentication](../authentication.md#internal-service-authentication)

## Cutover

The default Compose stack starts this service automatically. The steps below apply when
cutting over from the modular API one service at a time.

1. Apply the Prisma migrations and the staged database access scripts. Provision a PostgreSQL
   login that inherits only `smartdesk_analytics` and supply its connection string in
   `ANALYTICS_DATABASE_URL`. [Role setup](../database/service-access.md)
2. Supply a P-256 PKCS#8 signing key in `ANALYTICS_PRIVATE_KEY` and set `ANALYTICS_KEY_ID`.
   Add the matching SPKI public key to the backend's `INTERNAL_SERVICE_KEYS` registry under
   service `analytics` with the `identity:analytics-principal` user grant. Compose defaults
   `ANALYTICS_IDENTITY_ORIGIN` to `http://backend-api:4000`. Use HTTPS in production.
3. Start the private service while `ANALYTICS_EXECUTION_MODE=local`.

```bash
docker compose -f docker-compose.modular.yml --profile analytics up -d --build --wait analytics-service
```

Set `ANALYTICS_EXECUTION_MODE=service` for the backend and gateway, then recreate both.
Verify both report URLs through the gateway as an admin using a known reporting window.
Compare the totals and AI evaluation results with local mode.

```bash
docker compose -f docker-compose.modular.yml up -d --build backend gateway
```

## Rollback

Restore `ANALYTICS_EXECUTION_MODE=local` and recreate the backend and gateway. Verify both
report URLs through the gateway before stopping Analytics. Both modes use the same
PostgreSQL facts, so rollback needs only the routing change.

```bash
docker compose -f docker-compose.modular.yml up -d --build backend gateway
docker compose -f docker-compose.modular.yml --profile analytics stop analytics-service
```

The Compose verification compares both responses across seeded windows with reroutes,
reopened tickets, missing recommendations, and empty cohorts. It checks current admin
authorization, ticket creation during an Analytics outage, and report parity after rollback.
[Compose verification](../../docker/verify-analytics-service.sh)
