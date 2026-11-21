import { Prisma } from '@smartdesk/db';
import type { Db } from '../transaction.js';

export const insertComment = (
  db: Db,
  data: { ticketId: string; authorId: string; body: string; isInternal: boolean },
) => db.ticketComment.create({ data });

export const listComments = (db: Db, ticketId: string, includeInternal: boolean) =>
  db.ticketComment.findMany({
    where: { ticketId, ...(includeInternal ? {} : { isInternal: false }) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

/**
 * Record `commentId` as the ticket's first response if it is earlier than the current one (or there
 * is none). The comparison and write are one conditional UPDATE, so racing first replies cannot
 * overwrite each other with a later time. The timestamp is copied inside the database, keeping its
 * microseconds. Returns 1 when the ticket's first response now is this comment, otherwise 0.
 */
export async function recordFirstResponse(db: Db, commentId: string): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE tickets t
    SET first_response_at = c.created_at
    FROM ticket_comments c
    WHERE c.comment_id = ${commentId}::uuid
      AND t.ticket_id = c.ticket_id
      AND c.created_at >= t.created_at
      AND (t.first_response_at IS NULL OR t.first_response_at > c.created_at)`);
}

/**
 * Derive `first_response_at` for tickets that have none, from their comments (same rule as
 * `domain/firstResponse.ts` and migration 0006). Used after bulk-loading comments (seed data).
 */
export async function backfillFirstResponse(db: Db): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE tickets t
    SET first_response_at = fr.first_at
    FROM (
      SELECT c.ticket_id, MIN(c.created_at) AS first_at
      FROM ticket_comments c
      JOIN users u ON u.user_id = c.author_id
      JOIN tickets tk ON tk.ticket_id = c.ticket_id
      WHERE NOT c.is_internal
        AND u.role IN ('TECHNICIAN', 'ADMIN')
        AND c.author_id <> tk.requester_id
        AND c.created_at >= tk.created_at
      GROUP BY c.ticket_id
    ) fr
    WHERE t.ticket_id = fr.ticket_id AND t.first_response_at IS NULL`);
}
