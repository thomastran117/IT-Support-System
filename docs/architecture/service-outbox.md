# Cross-service events

SD-092 adds a PostgreSQL outbox for Ticket. Local mode serves the inbox and optional email
through the backend and its worker. SD-094 adds an independent Notifications service that
consumes the outbox. Tickets and committed event history stay available during a consumer outage.
[Notifications cutover and rollback](notifications-service.md)

## Version 1 contract

Each event has `schemaVersion`, `eventId`, `type`, `occurredAt` (UTC), `aggregateId` (ticket ID),
`aggregateVersion` (ticket version at publication), `correlationId`, and `payload`. Ticket
events share the audit event ID. Recommendation events use the recommendation ID.

| Type                    | Payload                                                        | Published when                                                                               |
| ----------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ticket.created`        | Empty object                                                   | A new ticket is saved. Repeated idempotent submissions reuse the existing ticket.            |
| `ticket.routed`         | `teamId`, optional `previousTeamId` (null on first assignment) | The ticket's assigned team changes, including a team change from an approved recommendation. |
| `ticket.status-changed` | `status`, optional `previousStatus`                            | A transition, resolution, reopen, or routing-driven triage changes the status.               |
| `ticket.public-reply`   | `commentId`                                                    | A public comment is saved.                                                                   |
| `recommendation.ready`  | `recommendationId`, `jobId`, `requestId`                       | A job first persists its recommendation and source links.                                    |

Routing, status, and public reply events can also carry `notification: { recipientId, type }`.
The existing requester policy supplies this reference for eligible events and excludes
self-notifications and inactive recipients at publication. Internal notes have no service event.
Payloads omit ticket and comment text, recommendation text, model metadata, emails, and raw
request headers. HTTP correlation IDs use SHA-256 of the Fastify request ID. Background
recommendations inherit the enqueuing request's digest when available and use the job request
UUID for older jobs. Ticket events produced without a request use their event UUID.

The shared contracts package also defines `recordRecommendationCommandV1Schema` for the
authenticated AI-to-Ticket request planned in SD-093. The command carries ticket, job, request,
and lease IDs, along with the bounded draft and cited article IDs. Ticket will validate job
ownership and the lease before saving the draft. Its database checks still validate references.
The draft travels in the authenticated request. The persisted event holds only result references.

Deploy decoders for a new schema version before its producers. Keep the existing v1 decoder while
v1 rows can be delivered or replayed. The v1 decoder enforces its allowlisted shapes. An invalid or
unsupported version of a subscribed type becomes a dead letter with `invalid_event`. Replay the
original event after deploying a compatible decoder.

## Delivery and recovery

- Producers insert into `service_outbox_events` inside the transaction that saves the source
  change. An append-only trigger protects event history. Publication starts when the producer
  build runs after migration 0015. Existing audits, recommendations, and notifications remain
  available.
- Consumers discover committed events for subscribed types without a high-water mark. A transaction
  that commits late remains discoverable. The durable `(consumer, event_id)` key tracks discovery,
  delivery, and completion. A claim lasts 30 seconds and rotates its lease token. PostgreSQL
  `FOR UPDATE SKIP LOCKED` lets workers reclaim different due rows concurrently.
  [PostgreSQL locking clause](https://www.postgresql.org/docs/16/sql-select.html#SQL-FOR-UPDATE-SHARE)
- Each handler commits its PostgreSQL effect and completion receipt together. A crash before commit
  rolls both back. A retry after commit finds the receipt. A stale worker cannot commit under an
  expired or replaced lease. Keep external calls out of this transaction. Existing email delivery
  has its own durable queue.
- The Notifications handler uses the existing `(recipient_id, event_id, type)` constraint. Its
  inserts use the source event timestamp for a recovered notice and leave existing `read_at`
  values intact. Distinct facts may share an aggregate version, and a later version may arrive first.
  The handler records each fact using its own event ID. Consumers that maintain a current-state
  projection must guard against stale versions when updating that projection.
- Handler failures retry after 5, 10, 20, and 40 seconds. The fifth failure or an abandoned fifth
  lease goes to `FAILED`. Only bounded reason codes are stored. Replaying a failed delivery resets
  its attempt budget and retains the original event. Completed receipts are retained for deduplication.

After Prisma migration 0015, run the Notifications maintenance command with the existing application
connection from the backend workspace. Each drain processes up to 100 due deliveries. Repeat it
to work through a backlog or to pick up retries when they become due.

```sh
npm run outbox:notifications -- drain
npm run outbox:notifications -- replay <failed-event-id>
```

Find dead letters and recovery context using IDs, timestamps, attempts, and reason codes.

```sql
SELECT d.event_id, e.type, e.schema_version, e.correlation_id, d.attempts, d.error_kind, d.finished_at
FROM service_outbox_deliveries d JOIN service_outbox_events e USING (event_id)
WHERE d.consumer = 'notifications' AND d.state = 'FAILED'
ORDER BY d.finished_at;
```

For rollback, stop running the drain and keep the inline path serving the inbox. If reverting
the application, leave migration 0015, its event history, and consumer receipts in PostgreSQL.
The previous code can continue writing to its existing tables. Reapply the producer build before
resuming outbox-dependent routing. The older build's writes during that window remain in the
existing audit and inbox tables.
