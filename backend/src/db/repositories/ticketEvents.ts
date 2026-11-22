import { Prisma } from '@smartdesk/db';
import type { TicketEventType } from '@smartdesk/contracts';
import { sanitizeEventDetails } from '../../domain/ticketEvents.js';
import { notificationTypeFor } from '../../domain/notifications.js';
import type { Db } from '../transaction.js';
import { recordNotification } from './notifications.js';

export type { TicketEventType };

/**
 * Append an audit event. `occurred_at` uses `clock_timestamp()` (not the transaction start time) so
 * several events written in one transaction keep their order when sorted by (occurred_at, event_id).
 * `actorId = null` records a system action. This is the only place events are written: details are
 * reduced to the allow-listed keys for the type (ids, statuses, flags), so secrets and private text
 * cannot be stored whatever the caller passes.
 *
 * A meaningful event also records the requester's in-app notification (SD-040) in the same
 * transaction, so a rolled-back change leaves neither. Returns the new event id.
 */
export async function appendEvent(
  db: Db,
  event: {
    ticketId: string;
    actorId: string | null;
    type: TicketEventType;
    details?: Record<string, unknown>;
  },
): Promise<string> {
  const details = sanitizeEventDetails(event.type, event.details);
  const rows = await db.$queryRaw<{ event_id: string }[]>(Prisma.sql`
    INSERT INTO ticket_events (ticket_id, actor_id, event_type, details, occurred_at)
    VALUES (${event.ticketId}::uuid, ${event.actorId}::uuid, ${event.type},
            ${JSON.stringify(details)}::jsonb, clock_timestamp())
    RETURNING event_id`);
  const eventId = rows[0]!.event_id;
  const type = notificationTypeFor(event.type, details);
  if (type) {
    await recordNotification(db, {
      eventId,
      ticketId: event.ticketId,
      actorId: event.actorId,
      type,
    });
  }
  return eventId;
}

export const listEvents = (db: Db, ticketId: string) =>
  db.ticketEvent.findMany({ where: { ticketId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
