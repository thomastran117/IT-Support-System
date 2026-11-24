# Independent Notifications service

SD-094 extracts the inbox API, outbox consumer, and optional SMTP dispatcher into
`backend/services/notifications`. The default `NOTIFICATIONS_EXECUTION_MODE=local` runs inbox
and email in the backend and its worker. Service mode routes `/api/notifications` and its
subpaths through the gateway to Notifications. The container uses a private API listener, a
scoped PostgreSQL login, and outbound access for SMTP.

Ticket records the notification decision in the same transaction as the source change. Internal
notes, the requester's own actions, and actions for inactive recipients produce no inbox notice.
In service mode, ticket resolution and audit writes continue while Notifications is unavailable.
When Notifications returns, it commits each receipt and inbox effect together. The existing
`(recipient_id, event_id, type)` key preserves notice IDs and read timestamps across retries.
[Outbox contracts and replay](service-outbox.md)

Notifications sends Identity a signed service credential bound to the browser's access token for
each inbox operation. Identity checks the current account and returns its recipient ID. All inbox
queries and read updates use this ID. A request to mark another recipient's notice read returns
`404`. The SMTP dispatcher checks recipient status and read state before sending.
[Service authentication](../authentication.md#internal-service-authentication)

## Cutover

1. Apply the Prisma migrations and staged access scripts. Provision a login that inherits
   `smartdesk_notifications` and supply it in `NOTIFICATIONS_DATABASE_URL`. Reapply
   `enable.sql` on databases with previously staged grants. [PostgreSQL access](../database/service-access.md)
2. Provide a P-256 PKCS#8 signing key in `NOTIFICATIONS_PRIVATE_KEY` and set `NOTIFICATIONS_KEY_ID`.
   Add its SPKI public key to the backend's `INTERNAL_SERVICE_KEYS` registry under the service name
   `notifications` with the `identity:notification-recipient` user grant. Use a private
   `NOTIFICATIONS_IDENTITY_ORIGIN`. Compose defaults to `http://backend-api:4000`. Use HTTPS
   in production.
3. Verify replay against the shared inbox using `npm run outbox:notifications -- drain` from
   the backend workspace. Let the legacy worker drain its active email, then set
   `NOTIFICATIONS_EXECUTION_MODE=service` for the backend, gateway, and worker.

```bash
docker compose stop -t 75 worker
docker compose up -d --build backend gateway worker
docker compose --profile notifications up -d --build --wait notifications-service
```

For optional email, set `EMAIL_TRANSPORT=smtp` and supply `NOTIFICATIONS_SMTP_USER` and
`NOTIFICATIONS_SMTP_PASSWORD`. The dispatcher reuses delivery records, leases, and stable
Message-IDs. A crash between the SMTP server accepting a message and the database recording
the acknowledgement can repeat a send with the same Message-ID.

## Rollback

Stop the independent service to drain active work. Set `NOTIFICATIONS_EXECUTION_MODE=local`
and restore the legacy worker's SMTP credentials if used. Recreate the backend, gateway, and
worker, then drain outstanding outbox events into the same inbox. Each drain handles up to 100
deliveries. Repeat for remaining events and due retries. Use the outbox runbook for dead letters.

```bash
docker compose --profile notifications stop -t 75 notifications-service
docker compose up -d --build backend gateway worker
docker compose exec backend npm run outbox:notifications -- drain
```

The Compose test exercises ticket resolution during a Notifications outage, recipient
authorization, backlog recovery, and read state after restarting the service and restoring
the original gateway route. [Compose verification](../../docker/verify-notifications-service.sh)
