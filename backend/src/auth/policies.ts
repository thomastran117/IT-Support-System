/**
 * Authorization policies. Pure functions of (principal, resource): no I/O, no framework types, so
 * they are trivially testable and every route applies the same rules. Routes must go through these
 * (or {@link ./ticketAccess.ts}) rather than comparing roles or ids inline.
 *
 * Decisions (see docs/authentication.md for the matrix):
 *  - EMPLOYEE: only their own tickets; never internal notes or raw audit data.
 *  - TECHNICIAN: tickets assigned to one of their active teams, plus the shared triage backlog
 *    (tickets with no team yet) provided they belong to at least one active team; and any ticket
 *    they requested themselves (read-only, like an employee).
 *  - ADMIN: all tickets (read and edit), plus account, label and analytics administration.
 */
import type { Principal as RequestPrincipal } from './guard.js';

/** What the policies need from a caller. Services pass this without building a full principal. */
export type Principal = Pick<RequestPrincipal, 'id' | 'role' | 'teamIds'>;

/** The ownership facts a ticket decision needs. */
export interface TicketScope {
  requesterId: string;
  assignedTeamId: string | null;
}

const isStaff = (p: Principal) => p.role === 'TECHNICIAN' || p.role === 'ADMIN';

/** Technician work scope: assigned to one of my teams, or an unrouted ticket in the shared backlog. */
export function inTechnicianScope(p: Principal, t: TicketScope): boolean {
  if (p.role !== 'TECHNICIAN' || p.teamIds.length === 0) return false;
  return t.assignedTeamId === null || p.teamIds.includes(t.assignedTeamId);
}

export function canReadTicket(p: Principal, t: TicketScope): boolean {
  if (p.role === 'ADMIN') return true;
  if (t.requesterId === p.id) return true;
  return inTechnicianScope(p, t);
}

/** Edit, approve routing/category/priority, assign, change status. Requesters cannot. */
export function canEditTicket(p: Principal, t: TicketScope): boolean {
  if (p.role === 'ADMIN') return true;
  return inTechnicianScope(p, t);
}

/** Public replies: anyone who can read the ticket. */
export function canComment(p: Principal, t: TicketScope): boolean {
  return canReadTicket(p, t);
}

/** Internal notes are staff-only: authoring and reading, within a ticket the staff member can work. */
export function canAuthorInternalNote(p: Principal, t: TicketScope): boolean {
  return canEditTicket(p, t);
}

export function canSeeInternalNotes(p: Principal, t: TicketScope): boolean {
  return canEditTicket(p, t);
}

/** The raw ticket_events timeline (actor ids, detail JSON). Requesters get a sanitised view instead. */
export function canViewRawAudit(p: Principal, t: TicketScope): boolean {
  return canEditTicket(p, t);
}

export const canManageAccounts = (p: Principal): boolean => p.role === 'ADMIN';
export const canManageClassificationLabels = (p: Principal): boolean => p.role === 'ADMIN';
export const canViewAdminAnalytics = (p: Principal): boolean => p.role === 'ADMIN';
/** Teams, team membership, categories and knowledge-base maintenance. */
export const canAdminister = (p: Principal): boolean => p.role === 'ADMIN';
export const canTriage = (p: Principal): boolean => isStaff(p);
