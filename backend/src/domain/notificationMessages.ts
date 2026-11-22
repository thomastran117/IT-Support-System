import type { NotificationType } from '@smartdesk/contracts';

/**
 * The wording an employee sees. It depends on the notification type only: no comment text, summary
 * or other free text is ever included, so a private note cannot leak through a notification.
 */
const MESSAGES: Record<NotificationType, string> = {
  TICKET_ASSIGNED: 'Your ticket was assigned to a support team.',
  TICKET_STATUS_CHANGED: 'The status of your ticket changed.',
  TICKET_RESOLVED: 'Your ticket was resolved.',
  TICKET_REOPENED: 'Your ticket was reopened.',
  TECHNICIAN_REPLY: 'A technician replied to your ticket.',
};

export const notificationMessage = (type: NotificationType): string => MESSAGES[type];
