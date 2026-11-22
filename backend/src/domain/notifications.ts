import type { NotificationType, TicketEventType } from '@smartdesk/contracts';
import { NOTIFICATION_TYPES } from '@smartdesk/contracts';

/**
 * Notification policy (SD-040), as pure data.
 *
 * Recipient: the ticket's requester, and only the requester. The recipient is chosen on the server
 * from the ticket row, never from client input. Nobody is notified of their own action, and a
 * deactivated requester is skipped (see `recordNotification`).
 *
 * Which ticket events notify the requester, and as what:
 *  - TEAM_ASSIGNED / TEAM_REASSIGNED  -> TICKET_ASSIGNED
 *  - STATUS_CHANGED                   -> TICKET_STATUS_CHANGED
 *  - RESOLVED                         -> TICKET_RESOLVED
 *  - REOPENED                         -> TICKET_REOPENED (only when someone else reopens it)
 *  - COMMENT_ADDED, public            -> TECHNICIAN_REPLY (only when someone else replies)
 *
 * Never notified: internal notes, AI review decisions, assignee, category and priority changes and
 * creation. These are either staff-only or already hidden from requesters in their timeline.
 */
export { NOTIFICATION_TYPES };
export type { NotificationType };

export function notificationTypeFor(
  eventType: TicketEventType,
  details: Record<string, unknown>,
): NotificationType | null {
  switch (eventType) {
    case 'TEAM_ASSIGNED':
    case 'TEAM_REASSIGNED':
      return 'TICKET_ASSIGNED';
    case 'STATUS_CHANGED':
      return 'TICKET_STATUS_CHANGED';
    case 'RESOLVED':
      return 'TICKET_RESOLVED';
    case 'REOPENED':
      return 'TICKET_REOPENED';
    case 'COMMENT_ADDED':
      // `isInternal` must be exactly false: a missing or malformed flag is treated as private.
      return details.isInternal === false ? 'TECHNICIAN_REPLY' : null;
    default:
      return null;
  }
}
