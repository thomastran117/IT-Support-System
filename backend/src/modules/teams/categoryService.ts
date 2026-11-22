import type { PrismaClient } from '@smartdesk/db';
import type { AdminCategoryDto } from '@smartdesk/contracts';
import { DbError, notFoundError } from '../../db/errors.js';
import { withTransaction } from '../../db/transaction.js';

const conflict = (message: string) => new DbError('CONFLICT', 409, message);

type Row = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
};

const toDto = (c: Row, ticketCount: number): AdminCategoryDto => ({
  id: c.id,
  name: c.name,
  description: c.description,
  isActive: c.isActive,
  ticketCount,
});

/**
 * Ticket category administration.
 *
 * Categories are deactivated, never deleted: an inactive category stops being offered for new
 * triage (the ticket service rejects it) but tickets, knowledge articles, AI recommendations and
 * evaluation labels that reference it keep resolving it.
 */
export function createCategoryService(prisma: PrismaClient) {
  const load = async (db: Pick<PrismaClient, 'ticketCategory'>, id: string) => {
    const category = await db.ticketCategory.findUnique({ where: { id } });
    if (!category) throw notFoundError('Category');
    return category;
  };

  const get = async (id: string): Promise<AdminCategoryDto> => {
    const category = await load(prisma, id);
    return toDto(category, await prisma.ticket.count({ where: { categoryId: id } }));
  };

  return {
    async list(): Promise<AdminCategoryDto[]> {
      const [categories, counts] = await Promise.all([
        prisma.ticketCategory.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
        prisma.ticket.groupBy({
          by: ['categoryId'],
          where: { categoryId: { not: null } },
          _count: { _all: true },
        }),
      ]);
      const byId = new Map(counts.map((c) => [c.categoryId, c._count._all]));
      return categories.map((c) => toDto(c, byId.get(c.id) ?? 0));
    },

    get,

    async create(input: { name: string; description?: string | null }): Promise<AdminCategoryDto> {
      const created = await withTransaction(prisma, async (tx) => {
        if (await tx.ticketCategory.findUnique({ where: { name: input.name } })) {
          throw conflict('A category with this name already exists');
        }
        return tx.ticketCategory.create({
          data: { name: input.name, description: input.description || null },
        });
      });
      return toDto(created, 0);
    },

    async update(
      id: string,
      input: { name?: string; description?: string | null },
    ): Promise<AdminCategoryDto> {
      await withTransaction(prisma, async (tx) => {
        await load(tx, id);
        if (input.name !== undefined) {
          const clash = await tx.ticketCategory.findUnique({ where: { name: input.name } });
          if (clash && clash.id !== id) throw conflict('A category with this name already exists');
        }
        await tx.ticketCategory.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description || null } : {}),
          },
        });
      });
      return get(id);
    },

    /** Idempotent. Deactivation never touches tickets, articles, recommendations or labels. */
    async setActive(id: string, isActive: boolean): Promise<AdminCategoryDto> {
      await withTransaction(prisma, async (tx) => {
        await load(tx, id);
        await tx.ticketCategory.update({ where: { id }, data: { isActive } });
      });
      return get(id);
    },
  };
}
