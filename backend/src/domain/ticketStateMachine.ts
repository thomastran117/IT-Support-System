import type { TicketPriority, TicketStatus } from '@smartdesk/contracts';

/**
 * The manual ticket workflow as pure data and functions (no I/O), so every edge and prerequisite is
 * unit-testable. The database CHECK constraints validate the final row; which edge was taken, and
 * whether it was legal, is decided here (see docs/database/deviations.md).
 *
 *   OPEN -> TRIAGED -> IN_PROGRESS -> RESOLVED -> CLOSED
 *   RESOLVED -> OPEN and CLOSED -> OPEN (reopen)
 */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['TRIAGED'],
  TRIAGED: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED', 'OPEN'],
  CLOSED: ['OPEN'],
};

export const TICKET_STATUSES = Object.keys(ALLOWED_TRANSITIONS) as TicketStatus[];

export const isAllowedTransition = (from: TicketStatus, to: TicketStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);

/** What must hold before work can start on a ticket (TRIAGED and IN_PROGRESS). */
export type Prerequisite = 'CATEGORY' | 'PRIORITY' | 'TEAM' | 'ACTIVE_TEAM' | 'ASSIGNEE';

/** The facts about a ticket that transition rules depend on, gathered by the service. */
export interface TransitionFacts {
  status: TicketStatus;
  categoryId: string | null;
  priority: TicketPriority;
  teamId: string | null;
  /** Meaningful only when `teamId` is set. */
  teamActive: boolean;
  assigneeId: string | null;
  /** True when the assignee is an active technician who belongs to the assigned team. */
  assigneeEligible: boolean;
  /** The ticket's current resolution summary, if any. */
  currentSummary: string | null;
}

export type TransitionEvaluation =
  | { ok: true; summary: string | null }
  | { ok: false; reason: 'INVALID_TRANSITION' }
  | { ok: false; reason: 'PREREQUISITE_FAILED'; missing: Prerequisite[] }
  | { ok: false; reason: 'SUMMARY_REQUIRED' };

const REQUIRES_PREREQUISITES: readonly TicketStatus[] = ['TRIAGED', 'IN_PROGRESS'];

/** Every prerequisite that is currently unmet, in a stable order. Empty means ready. */
export function missingPrerequisites(f: TransitionFacts): Prerequisite[] {
  const missing: Prerequisite[] = [];
  if (!f.categoryId) missing.push('CATEGORY');
  if (f.priority === 'UNSET') missing.push('PRIORITY');
  if (!f.teamId) missing.push('TEAM');
  else if (!f.teamActive) missing.push('ACTIVE_TEAM');
  if (f.assigneeId && !f.assigneeEligible) missing.push('ASSIGNEE');
  return missing;
}

/**
 * Decide whether `facts.status -> to` may happen. Nothing is corrected silently: a failure names
 * its reason and the ticket stays as it was.
 *
 * Resolution summary: RESOLVED needs a nonblank `requestedSummary`. CLOSED keeps the existing
 * summary unless a new nonblank one is supplied. Reopening clears it (the caller writes NULLs; the
 * RESOLVED event stays in the timeline).
 */
export function evaluateTransition(
  facts: TransitionFacts,
  to: TicketStatus,
  requestedSummary?: string | null,
): TransitionEvaluation {
  if (!isAllowedTransition(facts.status, to)) return { ok: false, reason: 'INVALID_TRANSITION' };

  if (REQUIRES_PREREQUISITES.includes(to)) {
    const missing = missingPrerequisites(facts);
    if (missing.length > 0) return { ok: false, reason: 'PREREQUISITE_FAILED', missing };
  }

  if (to === 'RESOLVED' || to === 'CLOSED') {
    const requested = requestedSummary?.trim() ?? '';
    const summary = requested || (to === 'CLOSED' ? (facts.currentSummary?.trim() ?? '') : '');
    if (!summary) return { ok: false, reason: 'SUMMARY_REQUIRED' };
    return { ok: true, summary };
  }
  return { ok: true, summary: null };
}
