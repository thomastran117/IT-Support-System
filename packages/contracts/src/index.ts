// Browser-safe shared contracts. Do not import server-only code (node:*, pg, fastify) here.
import { z } from 'zod';

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

// --- Support teams (SD-024) ----------------------------------------------------------------

export const TEAM_NAME_MAX = 100;
export const TEAM_DESCRIPTION_MAX = 1000;

/** What staff assignment forms need: a team's identity and nothing else. */
export interface TeamRefDto {
  id: string;
  name: string;
  description: string | null;
}

/** A category offered to technicians when approving routing. */
export interface CategoryRefDto {
  id: string;
  name: string;
  description: string | null;
}

/** A team member as an assignment dropdown needs them: no email, role or account state. */
export interface TeamMemberRefDto {
  id: string;
  displayName: string;
}

/** A team as an administrator manages it. */
export interface AdminTeamDto extends TeamRefDto {
  isActive: boolean;
  memberCount: number;
}

/** A team member as an administrator sees them. */
export interface AdminTeamMemberDto extends TeamMemberRefDto {
  email: string;
  isActive: boolean;
  joinedAt: string;
  /** Tickets (any status) currently assigned to this member within this team. */
  assignedTicketCount: number;
}

export interface CreateTeamRequest {
  name: string;
  description?: string | null;
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string | null;
}

export interface AddTeamMemberRequest {
  userId: string;
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
  /** Time of the first public staff response, or null. Stable once set. */
  firstResponseAt: string | null;
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
  /** Time of the first public staff response, or null. Stable once set. */
  firstResponseAt: string | null;
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
 * Every event type the ticket timeline can hold. The database CHECK `ck_ticket_events_type` must list
 * exactly these (a test compares them). Actions by the system (no user) are recorded with a null
 * actor, using the same types.
 */
export const TICKET_EVENT_TYPES = [
  'CREATED',
  'STATUS_CHANGED',
  'TEAM_ASSIGNED',
  'TEAM_REASSIGNED',
  'CATEGORY_UPDATED',
  'PRIORITY_UPDATED',
  'ASSIGNEE_UPDATED',
  'COMMENT_ADDED',
  'AI_REVIEWED',
  'RESOLVED',
  'REOPENED',
] as const;
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];

/**
 * One timeline entry (`GET /api/tickets/:id/events`, and `timeline` in the ticket detail).
 * Staff in scope get every event, the actor (null for a system action) and the sanitized details.
 * Requesters get a reduced view: some event types are hidden, the actor is always null and the
 * details are limited to status and priority changes.
 */
export interface TicketTimelineEntry {
  id: string;
  type: TicketEventType;
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

// --- Technician queues (SD-025) -------------------------------------------------------------

export type QueueSortOption = 'priority' | 'age';

/** One row of a technician queue. Summary fields only: no description, comments or requester. */
export interface QueueItemDto {
  id: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: NamedRef | null;
  assignee: NamedRef | null;
  createdAt: string;
  /** Minutes since the ticket was created, by the database clock. */
  ageMinutes: number;
  /** Send back as `expectedVersion` when approving routing or changing status. */
  version: number;
}

/** `GET /api/technician/queue` and `GET /api/technician/unassigned`. */
export interface QueuePage {
  items: QueueItemDto[];
  /** Everything matching the filters, not just this page. */
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

// --- Ticket transitions (SD-020) -------------------------------------------------------------

export const TICKET_RESOLUTION_MAX = 5000;

/**
 * Body of POST /api/tickets/:id/transitions. `expectedVersion` is the `version` the client last
 * read; the server answers 409 `VERSION_CONFLICT` when the ticket has moved on since.
 */
export interface TransitionRequest {
  to: TicketStatus;
  expectedVersion: number;
  /** Required for RESOLVED. Optional for CLOSED (the existing summary is kept). */
  resolutionSummary?: string;
}

/** Priorities a technician can approve; `UNSET` is only the initial state. */
export const APPROVABLE_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/**
 * `POST /api/tickets/:id/routing` (SD-026): the approved category, priority and team in one request,
 * with an optional assignee (`null` clears it). `expectedVersion` is the ticket `version` the
 * technician last read; a stale one is rejected with 409 `VERSION_CONFLICT`.
 */
export interface ApproveRoutingRequest {
  categoryId: string;
  priority: (typeof APPROVABLE_PRIORITIES)[number];
  teamId: string;
  assigneeId?: string | null;
  expectedVersion: number;
}

/**
 * Machine-readable reason in `details.code` of a 409 from a ticket mutation:
 * - VERSION_CONFLICT: stale `expectedVersion` (`details.currentVersion` has the current one)
 * - INVALID_TRANSITION: the workflow has no such edge (`details.from`, `details.to`)
 * - PREREQUISITE_FAILED: triage/start requirements unmet (`details.missing` lists them)
 */
export type TicketConflictCode = 'VERSION_CONFLICT' | 'INVALID_TRANSITION' | 'PREREQUISITE_FAILED';

export type TicketPrerequisite = 'CATEGORY' | 'PRIORITY' | 'TEAM' | 'ACTIVE_TEAM' | 'ASSIGNEE';

// --- Comments (SD-021) -----------------------------------------------------------------------

export const TICKET_COMMENT_MAX = 5000;

/** Body of POST /api/tickets/:id/comments. Only staff in scope may set `isInternal: true`. */
export interface CreateCommentRequest {
  body: string;
  isInternal?: boolean;
}

// --- Shared request validation (SD-023) -------------------------------------------------------

/**
 * The one definition of what a valid ticket or comment is. The API validates requests with these
 * schemas and the web forms validate with the very same objects, so client and server cannot
 * disagree about limits. Strict: unknown fields are rejected, never ignored.
 */
export const createTicketSchema = z.strictObject({
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX),
  description: z.string().trim().min(1).max(TICKET_DESCRIPTION_MAX),
});

export const createCommentSchema = z.strictObject({
  body: z.string().trim().min(1).max(TICKET_COMMENT_MAX),
  isInternal: z.boolean().default(false),
});

export const createTeamSchema = z.strictObject({
  name: z.string().trim().min(1).max(TEAM_NAME_MAX),
  description: z.string().trim().max(TEAM_DESCRIPTION_MAX).nullish(),
});

export const updateTeamSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(TEAM_NAME_MAX).optional(),
    description: z.string().trim().max(TEAM_DESCRIPTION_MAX).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Provide a name or a description',
  });

export const addTeamMemberSchema = z.strictObject({ userId: z.uuid() });

export const approveRoutingSchema = z.strictObject({
  categoryId: z.uuid(),
  priority: z.enum(APPROVABLE_PRIORITIES),
  teamId: z.uuid(),
  assigneeId: z.uuid().nullable().optional(),
  expectedVersion: z.number().int().min(1),
});

// --- Knowledge base (SD-029) -----------------------------------------------------------------

export const ARTICLE_TITLE_MAX = 200;
export const ARTICLE_BODY_MAX = 20_000;
export const ARTICLE_PAGE_SIZE_DEFAULT = 20;
export const ARTICLE_PAGE_SIZE_MAX = 50;

/**
 * An article as every signed-in user sees it. `body` is plain text with light Markdown: it is
 * data, never HTML. Clients must render it escaped (or through a Markdown renderer that disallows
 * raw HTML); the server strips control characters on write but does not rewrite markup.
 */
export interface KnowledgeArticleDto {
  id: string;
  title: string;
  body: string;
  category: NamedRef | null;
  createdAt: string;
  updatedAt: string;
}

/** The administrator view adds publication state. */
export interface AdminKnowledgeArticleDto extends KnowledgeArticleDto {
  isPublished: boolean;
}

/** List row: no body, so a page stays small. */
export interface KnowledgeArticleSummaryDto {
  id: string;
  title: string;
  category: NamedRef | null;
  updatedAt: string;
}

export interface AdminKnowledgeArticleSummaryDto extends KnowledgeArticleSummaryDto {
  isPublished: boolean;
}

/** `GET /api/knowledge` and `GET /api/admin/knowledge`. */
export interface ArticlePage<T> {
  items: T[];
  /** Everything matching the filters, not just this page. */
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export const SEARCH_QUERY_MAX = 200;
export const SEARCH_PAGE_SIZE_DEFAULT = 10;
export const SEARCH_PAGE_SIZE_MAX = 20;

/**
 * One hit of `GET /api/knowledge/search`: enough to render a result card and to cite the source
 * (`id`) from AI suggestions. `preview` is plain text (whitespace collapsed, at most 200 characters
 * plus an ellipsis); `rank` is relevance, higher first, comparable only within one response.
 */
export interface KnowledgeSearchResultDto {
  id: string;
  title: string;
  category: NamedRef | null;
  preview: string;
  rank: number;
}

const articleTitle = z.string().trim().min(1).max(ARTICLE_TITLE_MAX);
const articleBody = z.string().trim().min(1).max(ARTICLE_BODY_MAX);

/** Drafts are created unpublished; publishing is a separate, explicit action. */
export const createArticleSchema = z.strictObject({
  title: articleTitle,
  body: articleBody,
  categoryId: z.uuid().nullish(),
});

export const updateArticleSchema = z
  .strictObject({
    title: articleTitle.optional(),
    body: articleBody.optional(),
    categoryId: z.uuid().nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined || v.categoryId !== undefined, {
    message: 'Provide a title, body or category',
  });
