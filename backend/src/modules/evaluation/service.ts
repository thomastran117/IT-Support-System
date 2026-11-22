import type { PrismaClient } from '@smartdesk/db';
import type { ClassificationLabelDto, ClassificationLabelPage } from '@smartdesk/contracts';
import { DbError, notFoundError, validationError } from '../../db/errors.js';

const conflict = (message: string) => new DbError('CONFLICT', 409, message);

const include = {
  referenceCategory: { select: { id: true, name: true } },
  labeller: { select: { id: true, displayName: true } },
} as const;

type Row = {
  ticketId: string;
  labelledAt: Date;
  referenceCategory: { id: string; name: string };
  labeller: { id: string; displayName: string };
};

const toDto = (r: Row): ClassificationLabelDto => ({
  ticketId: r.ticketId,
  referenceCategory: r.referenceCategory,
  labelledBy: r.labeller,
  labelledAt: r.labelledAt.toISOString(),
});

/**
 * Independent reference labels for AI evaluation.
 *
 * The labeller is always the authenticated administrator passed in by the route. Nothing here reads
 * an AI recommendation or the technician-approved category, so a label can never be derived from a
 * prediction.
 */
export function createLabelService(prisma: PrismaClient) {
  const checkTargets = async (ticketId: string, categoryId: string) => {
    const [ticket, category] = await Promise.all([
      prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true } }),
      prisma.ticketCategory.findUnique({ where: { id: categoryId } }),
    ]);
    if (!ticket) throw notFoundError('Ticket');
    if (!category) throw validationError('Unknown category');
    if (!category.isActive) throw validationError('Choose an active category');
  };

  return {
    async get(ticketId: string): Promise<ClassificationLabelDto> {
      const row = await prisma.classificationLabel.findUnique({ where: { ticketId }, include });
      if (!row) throw notFoundError('Label');
      return toDto(row);
    },

    /** Creates the label; an existing one must be replaced explicitly with `replace`. */
    async create(actorId: string, ticketId: string, categoryId: string) {
      await checkTargets(ticketId, categoryId);
      if (await prisma.classificationLabel.findUnique({ where: { ticketId } })) {
        throw conflict('This ticket already has a label; use PUT to change it');
      }
      try {
        const row = await prisma.classificationLabel.create({
          data: { ticketId, referenceCategoryId: categoryId, labelledBy: actorId },
          include,
        });
        return toDto(row);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          throw conflict('This ticket already has a label; use PUT to change it');
        }
        throw err;
      }
    },

    /** Creates or replaces the label; the editor and time are recorded again. */
    async replace(actorId: string, ticketId: string, categoryId: string) {
      await checkTargets(ticketId, categoryId);
      const data = { referenceCategoryId: categoryId, labelledBy: actorId, labelledAt: new Date() };
      const row = await prisma.classificationLabel.upsert({
        where: { ticketId },
        create: { ticketId, ...data },
        update: data,
        include,
      });
      return toDto(row);
    },

    async list(limit: number, offset: number): Promise<ClassificationLabelPage> {
      const [rows, total] = await Promise.all([
        prisma.classificationLabel.findMany({
          include,
          orderBy: [{ labelledAt: 'desc' }, { ticketId: 'asc' }],
          take: limit,
          skip: offset,
        }),
        prisma.classificationLabel.count(),
      ]);
      return { items: rows.map(toDto), total };
    },
  };
}
