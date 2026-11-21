// Browser-safe shared contracts. Do not import server-only code (node:*, pg, fastify) here.

/** Consistent JSON envelope returned by every API response. */
export interface ApiEnvelope<T = unknown> {
  message: string;
  error: string | null;
  details: unknown;
  data: T | null;
}

export type HealthStatus = 'ok' | 'unavailable';

export interface LiveHealth {
  status: 'ok';
}

export interface ReadyHealth {
  status: HealthStatus;
  checks: { database: HealthStatus };
}

export const API_PREFIX = '/api';

// --- Authentication (SD-014) ---------------------------------------------------------------

export type Role = 'EMPLOYEE' | 'TECHNICIAN' | 'ADMIN';

/** Public profile of the signed-in user. Never contains credentials. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** Returned by login and refresh. The refresh token travels only in an HttpOnly cookie. */
export interface AuthSession {
  accessToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  user: AuthUser;
}

// --- Administration (SD-017) ---------------------------------------------------------------

/** An account as an administrator sees it. Never contains credentials or token state. */
export interface AdminUser extends AuthUser {
  isActive: boolean;
  createdAt: string;
}

export interface CreateUserRequest {
  email: string;
  displayName: string;
  role: Role;
}

/** Create and password-reset responses. The temporary password is shown exactly once. */
export interface UserWithTemporaryPassword {
  user: AdminUser;
  temporaryPassword: string;
}

export interface AdminUserList {
  items: AdminUser[];
  total: number;
}

export type AdminAuditAction =
  'USER_CREATED' | 'USER_ACTIVATED' | 'USER_DEACTIVATED' | 'ROLE_CHANGED' | 'PASSWORD_RESET';

export interface AdminAuditEntry {
  id: string;
  action: AdminAuditAction;
  actor: { id: string; email: string };
  target: { id: string; email: string };
  details: Record<string, unknown>;
  createdAt: string;
}

// --- Tickets (SD-018) ----------------------------------------------------------------------

export const TICKET_TITLE_MAX = 150;
export const TICKET_DESCRIPTION_MAX = 5000;
/** Header a client may send so that a retried submission returns the original ticket. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export type TicketStatus = 'OPEN' | 'TRIAGED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'UNSET' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Body of POST /api/tickets. Nothing else is accepted; the requester comes from the session. */
export interface CreateTicketRequest {
  title: string;
  description: string;
}

/**
 * A ticket as returned by the API. `version` is the optimistic concurrency token: mutating
 * endpoints take the version the client last read and answer 409 when it is stale.
 */
export interface TicketDto {
  id: string;
  /** The tracking ID shown to people; identical to `id`. */
  trackingId: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  categoryId: string | null;
  teamId: string | null;
  assigneeId: string | null;
  requesterId: string;
  resolutionSummary: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  version: number;
}

// --- Ticket list and detail (SD-019) ---------------------------------------------------------

export const TICKET_PAGE_SIZE_DEFAULT = 20;
export const TICKET_PAGE_SIZE_MAX = 100;

/** A named reference, resolved in the same query so clients never need follow-up lookups. */
export interface NamedRef {
  id: string;
  name: string;
}

export interface TicketSummaryDto {
  id: string;
  trackingId: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: NamedRef | null;
  team: NamedRef | null;
  assignee: NamedRef | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  version: number;
}

/** `GET /api/tickets`. Newest first; `total` counts everything the caller may see with the filters. */
export interface TicketPage {
  items: TicketSummaryDto[];
  total: number;
  limit: number;
  offset: number;
  /** Offset of the next page, or null on the last page. */
  nextOffset: number | null;
}

export interface TicketCommentDto {
  id: string;
  body: string;
  isInternal: boolean;
  author: NamedRef;
  createdAt: string;
}

/**
 * One line of the timeline summary. Requesters get type, time and status change only; staff also
 * get the actor and the structured details. The full timeline endpoint is SD-022.
 */
export interface TicketTimelineEntry {
  id: string;
  type: string;
  occurredAt: string;
  actor: NamedRef | null;
  details: Record<string, unknown> | null;
}

/** `GET /api/tickets/:id`. Internal notes and raw audit data only appear for staff in scope. */
export interface TicketDetailDto extends TicketSummaryDto {
  description: string;
  resolutionSummary: string | null;
  requester: NamedRef;
  comments: TicketCommentDto[];
  timeline: TicketTimelineEntry[];
}
