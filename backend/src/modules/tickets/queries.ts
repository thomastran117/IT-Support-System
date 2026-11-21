import type { Prisma, PrismaClient } from '@smartdesk/db';
import type {
  NamedRef,
  TicketCommentDto,
  TicketDetailDto,
  TicketPage,
  TicketPriority,
  TicketStatus,
  TicketSummaryDto,
  TicketTimelineEntry,
} from '@smartdesk/contracts';
import type { Principal } from '../../auth/guard.js';
import { canSeeInternalNotes, canViewRawAudit, type TicketScope } from '../../auth/policies.js';
import { ticketReadFilter } from '../../auth/ticketAccess.js';
import { toTimelineEntry } from '../../domain/ticketEvents.js';

/** Joined once per query so actors, team and category never cost one query per row. */
const summarySelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  firstResponseAt: true,
  version: true,
  category: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  assignee: { select: { id: true, displayName: true } },
} satisfies Prisma.TicketSelect;

type SummaryRow = Prisma.TicketGetPayload<{ select: typeof summarySelect }>;

const ref = (r: { id: string; name: string } | null): NamedRef | null =>
  r ? { id: r.id, name: r.name } : null;

function toSummary(t: SummaryRow): TicketSummaryDto {
  return {
    id: t.id,
    trackingId: t.id,
    title: t.title,
    status: t.status as TicketStatus,
    priority: t.priority as TicketPriority,
    category: ref(t.category),
    team: ref(t.team),
    assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.displayName } : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    firstResponseAt: t.firstResponseAt?.toISOString() ?? null,
    version: t.version,
  };
}

const commentSelect = {
  id: true,
  body: true,
  isInternal: true,
  createdAt: true,
  author: { select: { id: true, displayName: true } },
} satisfies Prisma.TicketCommentSelect;

type CommentRow = Prisma.TicketCommentGetPayload<{ select: typeof commentSelect }>;

const toCommentDto = (c: CommentRow): TicketCommentDto => ({
  id: c.id,
  body: c.body,
  isInternal: c.isInternal,
  author: { id: c.author.id, name: c.author.displayName },
  createdAt: c.createdAt.toISOString(),
});

/**
 * Comments in conversation order (created_at, then id, so equal timestamps are deterministic).
 * Internal notes are only selected for staff who may see them; for everyone else they are filtered
 * in the query itself, so they never reach serialization.
 */
export async function listTicketComments(
  prisma: PrismaClient,
  principal: Principal,
  scope: TicketScope & { id: string },
): Promise<TicketCommentDto[]> {
  const rows = await prisma.ticketComment.findMany({
    where: {
      ticketId: scope.id,
      ...(canSeeInternalNotes(principal, scope) ? {} : { isInternal: false }),
    },
    select: commentSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toCommentDto);
}

export interface ListFilter {
  status?: TicketStatus;
  priority?: TicketPriority;
  limit: number;
  offset: number;
}

/**
 * Role-scoped history. The visibility rule is the same filter the policies use, applied to both the
 * rows and the count, and the order (created_at, ticket_id) is total, so pages never overlap.
 */
export async function listTickets(
  prisma: PrismaClient,
  principal: Principal,
  f: ListFilter,
): Promise<TicketPage> {
  const where: Prisma.TicketWhereInput = {
    AND: [
      ticketReadFilter(principal),
      {
        ...(f.status ? { status: f.status } : {}),
        ...(f.priority ? { priority: f.priority } : {}),
      },
    ],
  };
  const [total, rows] = await Promise.all([
    prisma.ticket.count({ where }),
    prisma.ticket.findMany({
      where,
      select: summarySelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      skip: f.offset,
    }),
  ]);
  const next = f.offset + rows.length;
  return {
    items: rows.map(toSummary),
    total,
    limit: f.limit,
    offset: f.offset,
    nextOffset: next < total ? next : null,
  };
}

/**
 * The timeline for the caller's audience: staff who can view the raw audit see every event with its
 * actor; everyone else gets the reduced requester view. Ordered by (occurred_at, event_id), which
 * is total, so equal timestamps are deterministic.
 */
export async function listTicketEvents(
  prisma: PrismaClient,
  principal: Principal,
  scope: TicketScope & { id: string },
): Promise<TicketTimelineEntry[]> {
  const audience = canViewRawAudit(principal, scope) ? 'staff' : 'requester';
  const events = await prisma.ticketEvent.findMany({
    where: { ticketId: scope.id },
    select: {
      id: true,
      eventType: true,
      occurredAt: true,
      details: true,
      actor: { select: { id: true, displayName: true } },
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  return events.flatMap((e) => toTimelineEntry(e, audience) ?? []);
}

/**
 * Detail view for a ticket the caller can already read (authorizeTicket ran first). Three queries,
 * however many comments and events there are.
 */
export async function getTicketDetail(
  prisma: PrismaClient,
  principal: Principal,
  scope: TicketScope & { id: string },
): Promise<TicketDetailDto | null> {
  const [ticket, comments, timeline] = await Promise.all([
    prisma.ticket.findUnique({
      where: { id: scope.id },
      select: {
        ...summarySelect,
        description: true,
        resolutionSummary: true,
        requester: { select: { id: true, displayName: true } },
      },
    }),
    listTicketComments(prisma, principal, scope),
    listTicketEvents(prisma, principal, scope),
  ]);
  if (!ticket) return null;

  return {
    ...toSummary(ticket),
    description: ticket.description,
    resolutionSummary: ticket.resolutionSummary,
    requester: { id: ticket.requester.id, name: ticket.requester.displayName },
    comments,
    timeline,
  };
}
