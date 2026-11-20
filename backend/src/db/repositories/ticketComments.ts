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
