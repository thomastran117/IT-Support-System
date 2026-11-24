import { serviceEventV1Schema } from '@smartdesk/contracts';
import type { TransactionClient } from '@smartdesk/db';

/** Keep the trace joinable without persisting arbitrary text from a request header. */
export { hashCorrelationId } from '@smartdesk/service-runtime';

/** Write the validated envelope in the transaction that produced the event. */
export async function insertServiceEvent(tx: TransactionClient, envelope: unknown) {
  const event = serviceEventV1Schema.parse(envelope);
  await tx.$executeRaw`
    INSERT INTO service_outbox_events
      (event_id, schema_version, type, occurred_at, aggregate_id, aggregate_version, correlation_id, payload)
    VALUES (${event.eventId}::uuid, ${event.schemaVersion}, ${event.type}, ${event.occurredAt}::timestamptz,
            ${event.aggregateId}::uuid, ${event.aggregateVersion}, ${event.correlationId},
            ${JSON.stringify(event.payload)}::jsonb)`;
}
