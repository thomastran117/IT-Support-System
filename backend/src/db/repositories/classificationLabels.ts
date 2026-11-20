import type { Db } from '../transaction.js';

/** Independent reference label used only for accuracy evaluation; never copied from AI output. */
export const insertLabel = (
  db: Db,
  data: { ticketId: string; referenceCategoryId: string; labelledBy: string },
) => db.classificationLabel.create({ data });

export const findLabel = (db: Db, ticketId: string) =>
  db.classificationLabel.findUnique({ where: { ticketId } });
