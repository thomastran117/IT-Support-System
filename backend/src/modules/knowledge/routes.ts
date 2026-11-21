import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import {
  ARTICLE_PAGE_SIZE_DEFAULT,
  ARTICLE_PAGE_SIZE_MAX,
  createArticleSchema,
  updateArticleSchema,
} from '@smartdesk/contracts';
import { z } from 'zod';
import { envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';
import { createKnowledgeService } from './service.js';

const IdParams = z.object({ id: z.uuid() });
const Paging = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ARTICLE_PAGE_SIZE_MAX)
    .default(ARTICLE_PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
};
const ReaderQuery = z.object({ categoryId: z.uuid().optional(), ...Paging });
const AdminQuery = z.object({
  categoryId: z.uuid().optional(),
  published: z.enum(['true', 'false']).optional(),
  ...Paging,
});

/**
 * Reader API, mounted under /api/knowledge. Any signed-in user; published articles only. A draft
 * is a 404 here for every role (administrators use /api/admin/knowledge to see drafts).
 */
export const knowledgeRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const service = createKnowledgeService(prisma);
    const signedIn = { preHandler: app.authGuards.requireRole('EMPLOYEE', 'TECHNICIAN', 'ADMIN') };

    app.get('/', signedIn, async (req) => {
      const q = parse(ReaderQuery, req.query);
      return envelope(
        'Articles',
        await service.listPublished({ categoryId: q.categoryId }, q.limit, q.offset),
      );
    });

    app.get('/:id', signedIn, async (req) =>
      envelope('Article', await service.getPublished(parse(IdParams, req.params).id)),
    );
  };

/** Administrator-only authoring. Mounted under /api/admin/knowledge. */
export const adminKnowledgeRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const service = createKnowledgeService(prisma);
    const opts = { preHandler: app.authGuards.requireRole('ADMIN') };
    const articleId = (params: unknown) => parse(IdParams, params).id;

    app.get('/', opts, async (req) => {
      const q = parse(AdminQuery, req.query);
      return envelope(
        'Articles',
        await service.listAll(
          {
            categoryId: q.categoryId,
            published: q.published === undefined ? undefined : q.published === 'true',
          },
          q.limit,
          q.offset,
        ),
      );
    });

    app.post('/', opts, async (req, reply) => {
      const article = await service.create(parse(createArticleSchema, req.body));
      return reply.code(201).send(envelope('Article created', article));
    });

    app.get('/:id', opts, async (req) =>
      envelope('Article', await service.getAny(articleId(req.params))),
    );

    app.patch('/:id', opts, async (req) =>
      envelope(
        'Article updated',
        await service.update(articleId(req.params), parse(updateArticleSchema, req.body)),
      ),
    );

    app.post('/:id/publish', opts, async (req) =>
      envelope('Article published', await service.setPublished(articleId(req.params), true)),
    );
    app.post('/:id/unpublish', opts, async (req) =>
      envelope('Article unpublished', await service.setPublished(articleId(req.params), false)),
    );
  };
