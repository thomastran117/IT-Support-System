import type { Db } from '../transaction.js';

export const addMember = (db: Db, teamId: string, userId: string) =>
  db.teamMember.create({ data: { teamId, userId } });

export const isMember = async (db: Db, teamId: string, userId: string): Promise<boolean> =>
  (await db.teamMember.count({ where: { teamId, userId } })) > 0;

export const findTeam = (db: Db, id: string) => db.supportTeam.findUnique({ where: { id } });

export const findCategory = (db: Db, id: string) => db.ticketCategory.findUnique({ where: { id } });

export const findUser = (db: Db, id: string) => db.user.findUnique({ where: { id } });
