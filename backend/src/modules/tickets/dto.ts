import type { TicketRecord } from '../../db/repositories/tickets.js';
import type { TicketDto, TicketPriority, TicketStatus } from '@smartdesk/contracts';

/** Explicit allow-list mapping: new database columns never reach the API by accident. */
export function toTicketDto(t: TicketRecord): TicketDto {
  return {
    id: t.id,
    trackingId: t.id,
    title: t.title,
    description: t.description,
    status: t.status as TicketStatus,
    priority: t.priority as TicketPriority,
    categoryId: t.categoryId,
    teamId: t.assignedTeamId,
    assigneeId: t.assigneeId,
    requesterId: t.requesterId,
    resolutionSummary: t.resolutionSummary,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    version: t.version,
  };
}
