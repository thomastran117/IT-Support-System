import type { Prisma, PrismaClient } from '@smartdesk/db';
import { HttpError } from '../plugins/errors.js';
import type { Principal } from './guard.js';
import { canEditTicket, canReadTicket, type TicketScope } from './policies.js';

const NOT_FOUND = () => new HttpError(404, 'Ticket not found');

/**
 * Load a ticket's ownership facts and enforce a policy in one step. A ticket the caller may not
 * read is reported as 404, identical to a ticket that does not exist, so ids cannot be probed.
 * A ticket the caller may read but not modify is a 403.
 */
export async function authorizeTicket(
  prisma: Pick<PrismaClient, 'ticket'>,
  p: Principal,
  ticketId: string,
  access: 'read' | 'edit',
): Promise<TicketScope & { id: string }> {
  // Malformed ids are "not found" as well (and avoid a database cast error).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId)) {
    throw NOT_FOUND();
  }
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, requesterId: true, assignedTeamId: true },
  });
  if (!ticket || !canReadTicket(p, ticket)) throw NOT_FOUND();
  if (access === 'edit' && !canEditTicket(p, ticket)) {
    throw new HttpError(403, 'You do not have permission to modify this ticket');
  }
  return ticket;
}

/**
 * The same read rule as {@link canReadTicket}, as a query filter for list endpoints. Lists must
 * use this (never fetch-then-filter) so pagination and counts stay inside the caller's scope.
 * `ticketAccess` tests assert the two agree for every seeded user and ticket.
 */
export function ticketReadFilter(p: Principal): Prisma.TicketWhereInput {
  if (p.role === 'ADMIN') return {};
  const mine: Prisma.TicketWhereInput = { requesterId: p.id };
  if (p.role === 'TECHNICIAN' && p.teamIds.length > 0) {
    return {
      OR: [mine, { assignedTeamId: null }, { assignedTeamId: { in: [...p.teamIds] } }],
    };
  }
  return mine;
}
