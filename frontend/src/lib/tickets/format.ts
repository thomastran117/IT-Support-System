import type { TicketPriority, TicketStatus, TicketTimelineEntry } from '@smartdesk/contracts';
import { ApiError, NetworkError } from '../auth/client';

export const STATUS_ORDER: readonly TicketStatus[] = [
  'OPEN',
  'TRIAGED',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: 'Open',
  TRIAGED: 'Triaged',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

/** What each status means to the person who raised the ticket. */
export const STATUS_HELP: Record<TicketStatus, string> = {
  OPEN: 'Received. A technician has not reviewed it yet.',
  TRIAGED: 'Reviewed and assigned to a support team.',
  IN_PROGRESS: 'A technician is working on it.',
  RESOLVED: 'A fix was provided. Reply if it is not solved.',
  CLOSED: 'Completed.',
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  UNSET: 'Not set yet',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

const dateTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateTime.format(date);
}

/** A short, readable handle for lists; the full tracking ID is always shown on the ticket. */
export const shortId = (trackingId: string): string => trackingId.slice(0, 8).toUpperCase();

const label = (s: unknown): string => STATUS_LABEL[s as TicketStatus] ?? 'Unknown';
const priorityLabel = (p: unknown): string => PRIORITY_LABEL[p as TicketPriority] ?? 'Unknown';

/** One plain sentence per timeline event the requester can see. */
export function describeEvent(e: TicketTimelineEntry): string {
  const d = e.details ?? {};
  switch (e.type) {
    case 'CREATED':
      return 'Ticket submitted';
    case 'STATUS_CHANGED':
      return d.from && d.to
        ? `Status changed from ${label(d.from)} to ${label(d.to)}`
        : 'Status changed';
    case 'RESOLVED':
      return 'Marked as resolved';
    case 'REOPENED':
      return 'Reopened';
    case 'TEAM_ASSIGNED':
    case 'TEAM_REASSIGNED':
      return 'Assigned to a support team';
    case 'CATEGORY_UPDATED':
      return 'Category updated';
    case 'PRIORITY_UPDATED':
      return d.to ? `Priority set to ${priorityLabel(d.to)}` : 'Priority updated';
    default:
      // Types requesters never receive; shown generically rather than hidden if one ever arrives.
      return 'Ticket updated';
  }
}

/** Messages safe to show an employee. Never echoes server internals. */
export function describeError(err: unknown, what: string): string {
  if (err instanceof NetworkError) {
    return `Unable to reach the server. Your input is kept; check your connection and try again.`;
  }
  if (err instanceof ApiError) {
    if (err.status === 404) return `This ${what} could not be found.`;
    if (err.status === 429) return 'Too many requests. Please wait a moment and try again.';
    if (err.status === 400 || err.status === 422) {
      return 'The server did not accept this. Check what you entered and try again.';
    }
    if (err.status === 401) return 'Your session has ended. Please sign in again.';
  }
  return 'Something went wrong on our side. Your input is kept; please try again.';
}
