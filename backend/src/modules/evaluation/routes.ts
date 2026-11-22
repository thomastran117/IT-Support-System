import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import { classificationLabelSchema } from '@smartdesk/contracts';
import { z } from 'zod';
import { envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';
import { createLabelService } from './service.js';

const IdParams = z.object({ id: z.uuid() });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Independent reference labels. Administrator only, mounted under /api/admin/tickets. The labeller
 * is the JWT principal; the body can only carry the category (unknown keys are rejected).
 */
export const ticketLabelRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const service = createLabelService(prisma);
    const opts = { preHandler: app.authGuards.requireRole('ADMIN') };
    const actor = (req: { principal?: { id: string } }) => req.principal!.id;

    app.get('/:id/classification-label', opts, async (req) =>
      envelope('Classification label', await service.get(parse(IdParams, req.params).id)),
    );
    app.post('/:id/classification-label', opts, async (req, reply) => {
      const { referenceCategoryId } = parse(classificationLabelSchema, req.body);
      const ticketId = parse(IdParams, req.params).id;
      const label = await service.create(actor(req), ticketId, referenceCategoryId);
      return reply.code(201).send(envelope('Label created', label));
    });
    app.put('/:id/classification-label', opts, async (req) => {
      const { referenceCategoryId } = parse(classificationLabelSchema, req.body);
      const ticketId = parse(IdParams, req.params).id;
      return envelope(
        'Label saved',
        await service.replace(actor(req), ticketId, referenceCategoryId),
      );
    });
  };

/** Administrator-only list of labelled tickets. Mounted under /api/admin/classification-labels. */
export const labelListRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const service = createLabelService(prisma);
    app.get('/', { preHandler: app.authGuards.requireRole('ADMIN') }, async (req) => {
      const q = parse(ListQuery, req.query);
      return envelope('Classification labels', await service.list(q.limit, q.offset));
    });
  };
