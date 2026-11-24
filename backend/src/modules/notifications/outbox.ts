import type { ServiceEventV1 } from '@smartdesk/contracts';
import type { TransactionClient } from '@smartdesk/db';
import type { OutboxSubscription } from '../../db/repositories/serviceOutbox.js';

export const notificationSubscription = {
  name: 'notifications',
  types: ['ticket.routed', 'ticket.status-changed', 'ticket.public-reply'],
} as const satisfies OutboxSubscription;

/** Each notice is an independent fact, including late events and replies with the same version. */
export async function applyNotificationEvent(tx: TransactionClient, event: ServiceEventV1) {
  const { payload } = event;
  if (!('notification' in payload) || !payload.notification) return;
  const { recipientId, type } = payload.notification;
  await tx.$executeRaw`
    INSERT INTO notifications (recipient_id, ticket_id, event_id, type, created_at)
    VALUES (${recipientId}::uuid, ${event.aggregateId}::uuid, ${event.eventId}::uuid, ${type},
            ${event.occurredAt}::timestamptz)
    ON CONFLICT (recipient_id, event_id, type) DO NOTHING`;
}
