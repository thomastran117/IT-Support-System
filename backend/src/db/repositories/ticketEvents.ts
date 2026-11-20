import { Prisma } from '@smartdesk/db';
import type { Db } from '../transaction.js';

export type TicketEventType =
  | 'CREATED'
  | 'STATUS_CHANGED'
  | 'TEAM_ASSIGNED'
  | 'TEAM_REASSIGNED'
  | 'COMMENT_ADDED'
  | 'AI_REVIEWED'
  | 'RESOLVED'
  | 'REOPENED'
  | 'CATEGORY_UPDATED'
  | 'PRIORITY_UPDATED'
  | 'ASSIGNEE_UPDATED';

/**
 * Append an audit event. `occurred_at` uses `clock_timestamp()` (not the transaction start time) so
 * several events written in one transaction keep their order when sorted by (occurred_at, event_id).
 * `actorId = null` records a system action. Details must never contain secrets or private text.
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
            ${JSON.stringify(event.details ?? {})}::jsonb, clock_timestamp())`);
}

export const listEvents = (db: Db, ticketId: string) =>
  db.ticketEvent.findMany({ where: { ticketId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
