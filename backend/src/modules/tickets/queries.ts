import type { Prisma, PrismaClient } from '@smartdesk/db';
import type {
  NamedRef,
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

/** Joined once per query so actors, team and category never cost one query per row. */
const summarySelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
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
    version: t.version,
  };
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

/** Event types a requester may see. Their details are reduced to the status change. */
const REQUESTER_EVENT_TYPES = new Set([
  'CREATED',
  'STATUS_CHANGED',
  'RESOLVED',
  'REOPENED',
  'TEAM_ASSIGNED',
  'TEAM_REASSIGNED',
]);

/**
 * Detail view for a ticket the caller can already read (authorizeTicket ran first). Three queries,
 * however many comments and events there are.
 */
export async function getTicketDetail(
  prisma: PrismaClient,
  principal: Principal,
  scope: TicketScope & { id: string },
): Promise<TicketDetailDto | null> {
  const staff = canSeeInternalNotes(principal, scope);
  const rawAudit = canViewRawAudit(principal, scope);

  const [ticket, comments, events] = await Promise.all([
    prisma.ticket.findUnique({
      where: { id: scope.id },
      select: {
        ...summarySelect,
        description: true,
        resolutionSummary: true,
        requester: { select: { id: true, displayName: true } },
      },
    }),
    prisma.ticketComment.findMany({
      where: { ticketId: scope.id, ...(staff ? {} : { isInternal: false }) },
      select: {
        id: true,
        body: true,
        isInternal: true,
        createdAt: true,
        author: { select: { id: true, displayName: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.ticketEvent.findMany({
      where: { ticketId: scope.id },
      select: {
        id: true,
        eventType: true,
        occurredAt: true,
        details: true,
        actor: { select: { id: true, displayName: true } },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  if (!ticket) return null;

  const timeline: TicketTimelineEntry[] = events
    .filter((e) => rawAudit || REQUESTER_EVENT_TYPES.has(e.eventType))
    .map((e) => {
      const d = (e.details ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        type: e.eventType,
        occurredAt: e.occurredAt.toISOString(),
        actor: rawAudit && e.actor ? { id: e.actor.id, name: e.actor.displayName } : null,
        // Requesters only learn the status change, never ids, notes or other detail.
        details: rawAudit
          ? d
          : e.eventType === 'STATUS_CHANGED'
            ? { from: d.from ?? null, to: d.to ?? null }
            : null,
      };
    });

  return {
    ...toSummary(ticket),
    description: ticket.description,
    resolutionSummary: ticket.resolutionSummary,
    requester: { id: ticket.requester.id, name: ticket.requester.displayName },
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      isInternal: c.isInternal,
      author: { id: c.author.id, name: c.author.displayName },
      createdAt: c.createdAt.toISOString(),
    })),
    timeline,
  };
}
