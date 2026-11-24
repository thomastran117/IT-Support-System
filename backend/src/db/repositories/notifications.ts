import type { NotificationType } from '@smartdesk/contracts';
import { insertInboxNotification } from '@smartdesk/notifications';
import type { Db } from '../transaction.js';

/** Capture the eligibility decision in the Ticket transaction for either delivery mode. */
export async function findNotificationRecipient(db: Db, ticketId: string, actorId: string | null) {
  const [row] = await db.$queryRaw<{ requesterId: string }[]>`
    SELECT t.requester_id AS "requesterId"
    FROM tickets t
    JOIN users u ON u.user_id = t.requester_id AND u.is_active
    WHERE t.ticket_id = ${ticketId}::uuid AND t.requester_id IS DISTINCT FROM ${actorId}::uuid`;
  return row?.requesterId;
}

/**
 * Record one in-app notification for the ticket's requester, for the event that was just appended.
 * The recipient is read from the ticket row. Nothing is written when the requester is the actor
 * or is deactivated. The unique key
 * `(recipient_id, event_id, type)` plus `ON CONFLICT DO NOTHING` makes a repeat harmless: the same
 * event never yields a second user-visible item. Returns whether a row was inserted.
 */
export async function recordNotification(
  db: Db,
  input: { eventId: string; ticketId: string; actorId: string | null; type: NotificationType },
): Promise<boolean> {
  const recipientId = await findNotificationRecipient(db, input.ticketId, input.actorId);
  return recipientId ? insertInboxNotification(db, { ...input, recipientId }) : false;
}
