import type { PrismaClient } from '@smartdesk/db';
import { forbiddenError, notFoundError } from '../errors.js';
import { loadSql, normalizePage, paginated, type PageRequest } from '../sql.js';

/**
 * Typed entry points for the operational queries Q01-Q04 (sql/queries/*.sql).
 *
 * Authorization lives here, in the repository, because the SQL only filters by the ids it is given:
 * the acting user is re-read from the database, never taken from the request, and IDs from URLs
 * (team, ticket) are checked against that user before any query runs. All SQL is static text with
 * bound parameters; nothing is interpolated.
 */

type Role = 'EMPLOYEE' | 'TECHNICIAN' | 'ADMIN';
interface Actor {
  id: string;
  role: Role;
}

async function loadActor(prisma: PrismaClient, userId: string): Promise<Actor> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.isActive) throw forbiddenError();
  return { id: user.id, role: user.role as Role };
}

// --- Q01 --------------------------------------------------------------------------------------

export interface TicketHistoryRow {
  ticketId: string;
  title: string;
  status: string;
  priority: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Q01: the authenticated user's own tickets, newest first. */
export async function listEmployeeTickets(
  prisma: PrismaClient,
  actorId: string,
  page?: PageRequest,
): Promise<TicketHistoryRow[]> {
  const actor = await loadActor(prisma, actorId);
  const { limit, offset } = normalizePage(page);
  const rows = await prisma.$queryRawUnsafe<
    {
      ticket_id: string;
      title: string;
      status: string;
      priority: string;
      created_at: Date;
      updated_at: Date;
    }[]
  >(paginated(loadSql('queries/Q01_employee_ticket_history.sql'), 1), actor.id, limit, offset);
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// --- Q02 --------------------------------------------------------------------------------------

/** Optional, bounded filters shared by Q02 and Q03. Every field defaults to "no restriction". */
export interface QueueFilter {
  /** Q02 only; defaults to the unresolved set. Q03 is OPEN by definition. */
  statuses?: readonly string[];
  priorities?: readonly string[];
  categoryId?: string;
  /** Inclusive lower / exclusive upper bound on creation time. */
  createdFrom?: Date;
  createdTo?: Date;
  /** Q02 only: restrict to one assignee (the "assigned to me" view). */
  assigneeId?: string;
}

export type QueueSort = 'priority' | 'age';

export interface QueueRow {
  ticketId: string;
  title: string;
  priority: string;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  createdAt: Date;
  version: number;
  /** Minutes since creation, measured by the database clock. */
  ageMinutes: number;
}

const minutes = (v: { toString(): string } | number) => Number(v.toString());

async function authorizeTeamQueue(prisma: PrismaClient, actorId: string, teamId: string) {
  const actor = await loadActor(prisma, actorId);
  if (actor.role === 'EMPLOYEE') throw forbiddenError();
  if (actor.role === 'TECHNICIAN') {
    // Membership of an *active* team: an inactive team's queue is closed to technicians.
    const member = await prisma.teamMember.count({
      where: { teamId, userId: actor.id, team: { isActive: true } },
    });
    if (member === 0) throw forbiddenError();
  }
  return actor;
}

const teamArgs = (teamId: string, f: QueueFilter) => [
  teamId,
  f.statuses ? [...f.statuses] : null,
  f.priorities ? [...f.priorities] : null,
  f.categoryId ?? null,
  f.createdFrom ?? null,
  f.createdTo ?? null,
  f.assigneeId ?? null,
];

/** Q02: unresolved tickets of one team. Admins may read any team; technicians only their own active teams. */
export async function listTeamQueue(
  prisma: PrismaClient,
  actorId: string,
  teamId: string,
  page?: PageRequest,
  filter: QueueFilter = {},
  sort: QueueSort = 'priority',
): Promise<QueueRow[]> {
  await authorizeTeamQueue(prisma, actorId, teamId);
  const { limit, offset } = normalizePage(page);
  const rows = await prisma.$queryRawUnsafe<
    {
      ticket_id: string;
      title: string;
      priority: string;
      status: string;
      assignee_id: string | null;
      assignee_name: string | null;
      category_id: string | null;
      category_name: string | null;
      created_at: Date;
      version: number;
      age_minutes: { toString(): string } | number;
    }[]
  >(
    paginated(loadSql('queries/Q02_team_queue.sql'), 8),
    ...teamArgs(teamId, filter),
    sort,
    limit,
    offset,
  );
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    title: r.title,
    priority: r.priority,
    status: r.status,
    assigneeId: r.assignee_id,
    assigneeName: r.assignee_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    createdAt: r.created_at,
    version: r.version,
    ageMinutes: minutes(r.age_minutes),
  }));
}

/** Total tickets matching the same team and filters, for pagination. Same authorization as Q02. */
export async function countTeamQueue(
  prisma: PrismaClient,
  actorId: string,
  teamId: string,
  filter: QueueFilter = {},
): Promise<number> {
  await authorizeTeamQueue(prisma, actorId, teamId);
  const [row] = await prisma.$queryRawUnsafe<{ total: number }[]>(
    loadSql('queries/Q02_team_queue_count.sql'),
    ...teamArgs(teamId, filter),
  );
  return row?.total ?? 0;
}

// --- Q03 --------------------------------------------------------------------------------------

export interface BacklogRow {
  ticketId: string;
  title: string;
  priority: string;
  status: string;
  categoryId: string | null;
  categoryName: string | null;
  createdAt: Date;
  version: number;
  /** Minutes since creation, measured by the database clock. */
  ageMinutes: number;
}

const backlogArgs = (f: QueueFilter) => [
  f.priorities ? [...f.priorities] : null,
  f.categoryId ?? null,
  f.createdFrom ?? null,
  f.createdTo ?? null,
];

async function authorizeBacklog(prisma: PrismaClient, actorId: string) {
  const actor = await loadActor(prisma, actorId);
  if (actor.role === 'EMPLOYEE') throw forbiddenError();
  return actor;
}

/** Q03: OPEN tickets with no team (staff only). Oldest first unless `sort` is 'priority'. */
export async function listUnassignedBacklog(
  prisma: PrismaClient,
  actorId: string,
  page?: PageRequest,
  filter: QueueFilter = {},
  sort: QueueSort = 'age',
): Promise<BacklogRow[]> {
  await authorizeBacklog(prisma, actorId);
  const { limit, offset } = normalizePage(page);
  const rows = await prisma.$queryRawUnsafe<
    {
      ticket_id: string;
      title: string;
      priority: string;
      status: string;
      category_id: string | null;
      category_name: string | null;
      created_at: Date;
      version: number;
      age_minutes: { toString(): string } | number;
    }[]
  >(
    paginated(loadSql('queries/Q03_unassigned_backlog.sql'), 5),
    ...backlogArgs(filter),
    sort,
    limit,
    offset,
  );
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    title: r.title,
    priority: r.priority,
    status: r.status,
    categoryId: r.category_id,
    categoryName: r.category_name,
    createdAt: r.created_at,
    version: r.version,
    ageMinutes: minutes(r.age_minutes),
  }));
}

export async function countUnassignedBacklog(
  prisma: PrismaClient,
  actorId: string,
  filter: QueueFilter = {},
): Promise<number> {
  await authorizeBacklog(prisma, actorId);
  const [row] = await prisma.$queryRawUnsafe<{ total: number }[]>(
    loadSql('queries/Q03_unassigned_backlog_count.sql'),
    ...backlogArgs(filter),
  );
  return row?.total ?? 0;
}

// --- Q04 --------------------------------------------------------------------------------------

export interface AuditRow {
  eventType: string;
  occurredAt: Date;
  /** Display name of the actor; null for system events. */
  actor: string | null;
  details: Record<string, unknown>;
}

/**
 * Q04: a ticket's audit history. The requester gets the restricted variant (no internal notes,
 * routing or AI payloads); technicians of the ticket's team (or any technician for an unassigned
 * ticket) and admins get the full history. Anyone else receives the same 404 as a missing ticket,
 * so ticket ids cannot be probed.
 */
export async function getTicketAudit(
  prisma: PrismaClient,
  actorId: string,
  ticketId: string,
  page?: PageRequest,
): Promise<AuditRow[]> {
  const actor = await loadActor(prisma, actorId);
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw notFoundError('Ticket');

  let file = 'queries/Q04_ticket_audit.sql';
  if (actor.role === 'EMPLOYEE') {
    if (ticket.requesterId !== actor.id) throw notFoundError('Ticket');
    file = 'queries/Q04_ticket_audit_requester.sql';
  } else if (actor.role === 'TECHNICIAN' && ticket.assignedTeamId) {
    const member = await prisma.teamMember.count({
      where: { teamId: ticket.assignedTeamId, userId: actor.id },
    });
    if (member === 0) throw notFoundError('Ticket');
  }

  const { limit, offset } = normalizePage(page);
  const rows = await prisma.$queryRawUnsafe<
    {
      event_type: string;
      occurred_at: Date;
      actor: string | null;
      details: Record<string, unknown>;
    }[]
  >(paginated(loadSql(file), 1), ticket.id, limit, offset);
  return rows.map((r) => ({
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    actor: r.actor,
    details: r.details,
  }));
}
