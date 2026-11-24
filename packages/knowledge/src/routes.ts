import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from 'fastify';
import {
  ARTICLE_PAGE_SIZE_DEFAULT,
  ARTICLE_PAGE_SIZE_MAX,
  SEARCH_PAGE_SIZE_DEFAULT,
  SEARCH_PAGE_SIZE_MAX,
  SEARCH_QUERY_MAX,
  createArticleSchema,
  updateArticleSchema,
  type Role,
} from '@smartdesk/contracts';
import { z } from 'zod';
import { HttpError } from '@smartdesk/db/errors';
import type { createKnowledgeService } from './service.js';

type RequireRole = (...roles: Role[]) => preHandlerAsyncHookHandler | preHandlerAsyncHookHandler[];
type KnowledgeService = ReturnType<typeof createKnowledgeService>;

const envelope = <T>(message: string, data: T) => ({ message, data, error: null, details: null });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new HttpError(400, 'Validation failed', z.flattenError(result.error).fieldErrors);
  return result.data;
}

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
const SearchQuery = z.object({
  // Blank is allowed and returns an empty page; over-long input is rejected rather than truncated.
  q: z.string().max(SEARCH_QUERY_MAX).default(''),
  categoryId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).max(1_000).default(0),
});
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
  (service: KnowledgeService, requireRole: RequireRole): FastifyPluginAsync =>
  async (app) => {
    const signedIn = { preHandler: requireRole('EMPLOYEE', 'TECHNICIAN', 'ADMIN') };

    app.get('/', signedIn, async (req) => {
      const q = parse(ReaderQuery, req.query);
      return envelope(
        'Articles',
        await service.listPublished({ categoryId: q.categoryId }, q.limit, q.offset),
      );
    });

    app.get('/categories', signedIn, async () =>
      envelope('Categories', await service.listCategories()),
    );

    // Registered before `/:id`; `search` is not a valid uuid so the two can never collide.
    app.get('/search', signedIn, async (req) => {
      const q = parse(SearchQuery, req.query);
      return envelope(
        'Search results',
        await service.search(q.q, { categoryId: q.categoryId }, q.limit, q.offset),
      );
    });

    app.get('/:id', signedIn, async (req) =>
      envelope('Article', await service.getPublished(parse(IdParams, req.params).id)),
    );
  };

/** Administrator-only authoring. Mounted under /api/admin/knowledge. */
export const adminKnowledgeRoutes =
  (service: KnowledgeService, requireRole: RequireRole): FastifyPluginAsync =>
  async (app) => {
    const opts = { preHandler: requireRole('ADMIN') };
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
