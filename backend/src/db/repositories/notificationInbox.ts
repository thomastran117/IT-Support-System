import { Prisma } from '@smartdesk/db';
import type { Db } from '../transaction.js';

export interface InboxRow {
  id: string;
  type: string;
  ticketId: string;
  ticketTitle: string;
  readAt: Date | null;
  createdAt: Date;
}

/**
 * Every query is scoped by `recipient_id`, which callers take from the authenticated principal.
 * Ordering is `(created_at DESC, notification_id DESC)`, a total order, so paging is stable.
 */
export async function listInbox(
  db: Db,
  recipientId: string,
  opts: { unreadOnly: boolean; limit: number; offset: number },
): Promise<InboxRow[]> {
  return db.$queryRaw<InboxRow[]>(Prisma.sql`
    SELECT n.notification_id AS "id", n.type, n.ticket_id AS "ticketId", t.title AS "ticketTitle",
           n.read_at AS "readAt", n.created_at AS "createdAt"
    FROM notifications n
    JOIN tickets t ON t.ticket_id = n.ticket_id
    WHERE n.recipient_id = ${recipientId}::uuid
      ${opts.unreadOnly ? Prisma.sql`AND n.read_at IS NULL` : Prisma.empty}
    ORDER BY n.created_at DESC, n.notification_id DESC
    LIMIT ${opts.limit} OFFSET ${opts.offset}`);
}

export const countInbox = (db: Db, recipientId: string, unreadOnly: boolean) =>
  db.notification.count({
    where: { recipientId, ...(unreadOnly ? { readAt: null } : {}) },
  });

/**
 * Mark one notification read. Idempotent (the first read time is kept) and recipient-checked in the
 * statement itself. Returns false when it does not exist or belongs to someone else.
 */
export async function markRead(db: Db, recipientId: string, id: string): Promise<boolean> {
  const rows = await db.$executeRaw(Prisma.sql`
    UPDATE notifications SET read_at = COALESCE(read_at, now())
    WHERE notification_id = ${id}::uuid AND recipient_id = ${recipientId}::uuid`);
  return rows > 0;
}

export async function markAllRead(db: Db, recipientId: string): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE notifications SET read_at = now()
    WHERE recipient_id = ${recipientId}::uuid AND read_at IS NULL`);
}
