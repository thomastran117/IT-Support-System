import { Prisma } from '@smartdesk/db';
import type { TicketEventType } from '@smartdesk/contracts';
import { sanitizeEventDetails } from '../../domain/ticketEvents.js';
import type { Db } from '../transaction.js';

export type { TicketEventType };

/**
 * Append an audit event. `occurred_at` uses `clock_timestamp()` (not the transaction start time) so
 * several events written in one transaction keep their order when sorted by (occurred_at, event_id).
 * `actorId = null` records a system action. This is the only place events are written: details are
 * reduced to the allow-listed keys for the type (ids, statuses, flags), so secrets and private text
 * cannot be stored whatever the caller passes.
 */
export async function appendEvent(
  db: Db,
  event: {
    ticketId: string;
    actorId: string | null;
    type: TicketEventType;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO ticket_events (ticket_id, actor_id, event_type, details, occurred_at)
    VALUES (${event.ticketId}::uuid, ${event.actorId}::uuid, ${event.type},
            ${JSON.stringify(sanitizeEventDetails(event.type, event.details))}::jsonb, clock_timestamp())`);
}

export const listEvents = (db: Db, ticketId: string) =>
  db.ticketEvent.findMany({ where: { ticketId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
