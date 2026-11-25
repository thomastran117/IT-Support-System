# Independent Identity service

SD-097 moves `/api/auth`, `/api/admin/users`, and `/api/admin/audit-log` to an opt-in
Fastify service. Both modes use the same session and account handlers. Identity uses a
scoped PostgreSQL login over the existing users and audit tables. It keeps Argon2id
credentials, account IDs, token versions, and the last-active-admin transaction.
The existing refresh cookie keeps its name, path, origin check, and rotation behavior.
Temporary passwords are revealed in the provisioning or reset response and stored as hashes.
[Account and session behavior](../authentication.md)

Identity validates the current account against each JWT's token version. In service mode,
Ticket sends a short-lived ES256 credential bound to the caller's access token to
`/internal/identity/ticket-principal`. The response contains the account ID and token
version. Ticket reads its active membership and safe account metadata from PostgreSQL
and compares the current token version before applying its own authorization policies.
Notifications, Analytics, and Knowledge keep their existing scoped lookup paths and switch
to the independent Identity listener.

Identity and its callers check current authorization on every request. Access decisions
and account lookups bypass Redis. Redis can still share login and refresh quotas between
instances, with the existing bounded local counters on a Redis failure. Identity transport
failure returns `503` for protected Ticket operations, and invalid or revoked credentials
return `401`. Ticket's health checks and system-only operations keep their own dependencies.

## Cutover

The default Compose stack starts this service automatically. The steps below apply when
cutting over from the modular API one service at a time.

1. Apply the Prisma migrations and staged access scripts. Provision a login that inherits
   only `smartdesk_identity` and supply it in `IDENTITY_DATABASE_URL`.
   [Role setup](../database/service-access.md)
2. Copy the current browser signing key to `IDENTITY_JWT_SECRET`. Keep the JWT issuer,
   audience, lifetimes, frontend origin, and cookie settings aligned. In a production
   service-mode deployment, supply a separate `TICKET_SEARCH_CURSOR_SECRET` of at least
   32 random characters. Search cursors issued with a different key become invalid at cutover.
3. Give Ticket a P-256 PKCS#8 key in `TICKET_IDENTITY_PRIVATE_KEY` and set
   `TICKET_IDENTITY_KEY_ID`. Register its matching SPKI public key under service `ticket`
   with the `identity:ticket-principal` user grant in `INTERNAL_SERVICE_KEYS`. Include
   the existing delegation grants for any independent Notifications, Analytics, or Knowledge
   runtime. Compose uses `IDENTITY_SERVICE_ORIGIN` for those services and Ticket. Use a
   private HTTPS origin in production.
4. Start Identity while `IDENTITY_EXECUTION_MODE=local`.

```bash
docker compose -f docker-compose.modular.yml --profile identity up -d --build --wait identity-service
```

Set `IDENTITY_EXECUTION_MODE=service`, remove the browser signing key from Ticket's
runtime configuration, and recreate the backend and gateway. Recreate any active independent
Notifications, Analytics, and Knowledge containers with the same mode and origin.
Verify an existing session, a revoked session, and a protected Ticket request through the
gateway. Coordinate the switch so account writes use one route owner.

```bash
docker compose -f docker-compose.modular.yml up -d --build backend gateway
```

## Rollback

Stop Identity to drain active account requests. Restore the same browser signing key in
`JWT_SECRET` for the backend and set `IDENTITY_EXECUTION_MODE=local`. Recreate the backend,
gateway, and any active delegation callers. Local lookup URLs return to their
per-service settings. The current account rows, token versions, and audit data carry
through the switch. Verify a service-issued session and an account that was revoked
before rollback.

```bash
docker compose -f docker-compose.modular.yml --profile identity stop identity-service
docker compose -f docker-compose.modular.yml up -d --build backend gateway
```

The Compose verification exercises login, refresh, logout, role and password changes,
concurrent administrator deactivation, membership changes, scoped delegation, outage
handling, and service-issued session continuity after rollback.
[Compose verification](../../docker/verify-identity-service.sh)
