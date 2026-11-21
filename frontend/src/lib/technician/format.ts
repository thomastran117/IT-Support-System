import type {
  TicketPriority,
  TicketStatus,
  TicketTimelineEntry,
  TransitionRequest,
} from '@smartdesk/contracts';
import { ApiError, NetworkError } from '../auth/client';
import { PRIORITY_LABEL, STATUS_LABEL } from '../tickets/format';

/** "5 min", "3 h 20 min", "2 d 4 h": enough precision to compare tickets at a glance. */
export function formatAge(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export const APPROVABLE: readonly TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface StatusAction {
  to: TicketStatus;
  label: string;
  /** The server rejects the move without a nonblank summary. */
  needsSummary?: boolean;
}

/** The manual workflow edges the backend allows (see docs/api.md), as buttons. */
export function statusActions(status: TicketStatus): StatusAction[] {
  switch (status) {
    case 'TRIAGED':
      return [{ to: 'IN_PROGRESS', label: 'Start work' }];
    case 'IN_PROGRESS':
      return [{ to: 'RESOLVED', label: 'Resolve', needsSummary: true }];
    case 'RESOLVED':
      return [
        { to: 'CLOSED', label: 'Close' },
        { to: 'OPEN', label: 'Reopen' },
      ];
    case 'CLOSED':
      return [{ to: 'OPEN', label: 'Reopen' }];
    default:
      // OPEN becomes TRIAGED by approving routing, not by a button.
      return [];
  }
}

/** Routing can only be changed while the ticket is unresolved. */
export const canRoute = (status: TicketStatus): boolean =>
  status === 'OPEN' || status === 'TRIAGED' || status === 'IN_PROGRESS';

export function transitionRequest(
  action: StatusAction,
  expectedVersion: number,
  summary: string,
): TransitionRequest {
  const text = summary.trim();
  return {
    to: action.to,
    expectedVersion,
    ...(action.to === 'RESOLVED' && text ? { resolutionSummary: text } : {}),
  };
}

const status = (s: unknown) => STATUS_LABEL[s as TicketStatus] ?? 'Unknown';
const priority = (p: unknown) => PRIORITY_LABEL[p as TicketPriority] ?? 'Unknown';

/** Staff see every event, with who did it. Details hold ids only, so values are not named here. */
export function describeStaffEvent(e: TicketTimelineEntry): string {
  const d = e.details ?? {};
  const who = e.actor?.name ?? 'System';
  switch (e.type) {
    case 'CREATED':
      return `${who} submitted the ticket`;
    case 'STATUS_CHANGED':
      return d.from && d.to
        ? `${who} changed status from ${status(d.from)} to ${status(d.to)}`
        : `${who} changed the status`;
    case 'RESOLVED':
      return `${who} resolved the ticket`;
    case 'REOPENED':
      return `${who} reopened the ticket`;
    case 'TEAM_ASSIGNED':
      return `${who} assigned a support team`;
    case 'TEAM_REASSIGNED':
      return `${who} moved the ticket to another team`;
    case 'CATEGORY_UPDATED':
      return `${who} changed the category`;
    case 'PRIORITY_UPDATED':
      return d.to ? `${who} set priority to ${priority(d.to)}` : `${who} changed the priority`;
    case 'ASSIGNEE_UPDATED':
      return `${who} changed the assignee`;
    case 'COMMENT_ADDED':
      return d.isInternal === true ? `${who} added an internal note` : `${who} replied`;
    case 'AI_REVIEWED':
      return `${who} reviewed an AI suggestion`;
    default:
      return `${who} updated the ticket`;
  }
}

export type TriageErrorKind =
  'conflict' | 'validation' | 'forbidden' | 'gone' | 'network' | 'other';

export interface TriageError {
  kind: TriageErrorKind;
  message: string;
}

/** Messages for staff actions. A 409 version conflict is distinguished so the UI can reload. */
export function describeTriageError(err: unknown): TriageError {
  if (err instanceof NetworkError) {
    return {
      kind: 'network',
      message:
        'Unable to reach the server. Your changes are kept; check your connection and retry.',
    };
  }
  if (err instanceof ApiError) {
    const code = (err.details as { code?: string } | null)?.code;
    if (err.status === 409 && code === 'VERSION_CONFLICT') {
      return {
        kind: 'conflict',
        message:
          'Someone else changed this ticket while you were working on it. The latest version has been loaded; review it and apply your change again.',
      };
    }
    if (err.status === 409 || err.status === 400 || err.status === 422) {
      return {
        kind: 'validation',
        message: err.message || 'The server did not accept this. Check the values and try again.',
      };
    }
    if (err.status === 403) {
      return { kind: 'forbidden', message: 'You are not allowed to do that on this ticket.' };
    }
    if (err.status === 404) {
      return { kind: 'gone', message: 'This ticket is not available to you.' };
    }
  }
  return { kind: 'other', message: 'Something went wrong on our side. Please try again.' };
}
