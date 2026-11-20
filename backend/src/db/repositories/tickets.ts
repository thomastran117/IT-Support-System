import { Prisma } from '@smartdesk/db';
import type { Db } from '../transaction.js';

export type TicketStatus = 'OPEN' | 'TRIAGED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'UNSET' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const insertTicket = (
  db: Db,
  data: { requesterId: string; title: string; description: string; idempotencyKey?: string | null },
) => db.ticket.create({ data });

/** The ticket a requester already created under this idempotency key, if any. */
export const findByIdempotencyKey = (db: Db, requesterId: string, idempotencyKey: string) =>
  db.ticket.findUnique({
    where: { requesterId_idempotencyKey: { requesterId, idempotencyKey } },
  });

export const findTicket = (db: Db, id: string) => db.ticket.findUnique({ where: { id } });

export type TicketRecord = NonNullable<Awaited<ReturnType<typeof findTicket>>>;

/** Patch approved fields. `updated_at` and the concurrency `version` move on every mutation. */
export const patchTicket = (db: Db, id: string, data: Prisma.TicketUncheckedUpdateInput) =>
  db.ticket.update({
    where: { id },
    data: { ...data, updatedAt: new Date(), version: { increment: 1 } },
  });

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
        updated_at = clock_timestamp(),
        version = version + 1
    WHERE ticket_id = ${id}::uuid`);
}
