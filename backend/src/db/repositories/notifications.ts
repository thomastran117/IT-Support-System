import { Prisma } from '@smartdesk/db';
import type { NotificationType } from '@smartdesk/contracts';
import type { Db } from '../transaction.js';

/**
 * Record one in-app notification for the ticket's requester, for the event that was just appended.
 * The recipient is read from the ticket row inside the same statement, so it can never be supplied
 * by a caller. Nothing is written when the requester is the actor or is deactivated. The unique key
 * `(recipient_id, event_id, type)` plus `ON CONFLICT DO NOTHING` makes a repeat harmless: the same
 * event never yields a second user-visible item. Returns whether a row was inserted.
 */
export async function recordNotification(
  db: Db,
  input: { eventId: string; ticketId: string; actorId: string | null; type: NotificationType },
): Promise<boolean> {
  const inserted = await db.$executeRaw(Prisma.sql`
    INSERT INTO notifications (recipient_id, ticket_id, event_id, type)
    SELECT t.requester_id, t.ticket_id, ${input.eventId}::uuid, ${input.type}
    FROM tickets t
    JOIN users u ON u.user_id = t.requester_id AND u.is_active
    WHERE t.ticket_id = ${input.ticketId}::uuid
      AND t.requester_id IS DISTINCT FROM ${input.actorId}::uuid
    ON CONFLICT (recipient_id, event_id, type) DO NOTHING`);
  return inserted > 0;
}
