import { Prisma } from '@smartdesk/db';
import type { Db } from '../transaction.js';

export type TicketStatus = 'OPEN' | 'TRIAGED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'UNSET' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const insertTicket = (
  db: Db,
  data: { requesterId: string; title: string; description: string },
) => db.ticket.create({ data });

export const findTicket = (db: Db, id: string) => db.ticket.findUnique({ where: { id } });

/** Patch approved fields. `updated_at` is bumped by the service on every mutation. */
export const patchTicket = (db: Db, id: string, data: Prisma.TicketUncheckedUpdateInput) =>
  db.ticket.update({ where: { id }, data: { ...data, updatedAt: new Date() } });

/**
 * Mark a ticket RESOLVED/CLOSED. `resolved_at` comes from the database clock and is never earlier
 * than `created_at`, so the `resolved_at >= created_at` CHECK holds even with app/DB clock skew.
 */
export async function markResolved(
  db: Db,
  id: string,
  status: 'RESOLVED' | 'CLOSED',
  summary: string,
  keepResolvedAt: boolean,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE tickets
    SET status = ${status},
        resolution_summary = ${summary},
        resolved_at = ${keepResolvedAt ? Prisma.raw('COALESCE(resolved_at, clock_timestamp())') : Prisma.raw('GREATEST(clock_timestamp(), created_at)')},
        updated_at = clock_timestamp()
    WHERE ticket_id = ${id}::uuid`);
}
