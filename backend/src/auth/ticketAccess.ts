import type { Prisma, PrismaClient } from '@smartdesk/db';
import { HttpError } from '../plugins/errors.js';
import type { Principal } from './guard.js';
import { canEditTicket, canReadTicket, type TicketScope } from './policies.js';

const NOT_FOUND = () => new HttpError(404, 'Ticket not found');

export const isTicketId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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
  if (!isTicketId(ticketId)) {
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

/** Translate the read rules into the scope shared by SQL and the search candidate query. */
export function ticketReadScope(p: Principal) {
  if (p.role === 'ADMIN') return { kind: 'all' } as const;
  return {
    kind: 'scoped',
    requesterId: p.id,
    teamIds: p.role === 'TECHNICIAN' ? p.teamIds : [],
  } as const;
}

/**
 * The same read rule as {@link canReadTicket}, as a query filter for list endpoints. Lists must
 * use this (never fetch-then-filter) so pagination and counts stay inside the caller's scope.
 * `ticketAccess` tests assert the two agree for every seeded user and ticket.
 */
export function ticketReadFilter(p: Principal): Prisma.TicketWhereInput {
  const scope = ticketReadScope(p);
  if (scope.kind === 'all') return {};
  const mine: Prisma.TicketWhereInput = { requesterId: scope.requesterId };
  if (scope.teamIds.length > 0) {
    return {
      OR: [mine, { assignedTeamId: null }, { assignedTeamId: { in: [...scope.teamIds] } }],
    };
  }
  return mine;
}
