import type { PrismaClient } from '@smartdesk/db';
import type {
  AdminKnowledgeArticleDto,
  AdminKnowledgeArticleSummaryDto,
  ArticlePage,
  CategoryRefDto,
  KnowledgeArticleDto,
  KnowledgeArticleSummaryDto,
  KnowledgeSearchResultDto,
} from '@smartdesk/contracts';
import { DbError, notFoundError, validationError } from '../../db/errors.js';
import * as articles from '../../db/repositories/knowledge.js';
import type { ArticleRow } from '../../db/repositories/knowledge.js';

// Everything except tab, LF and CR: NUL and other control characters have no place in an article.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (s: string) => s.replace(CONTROL_CHARS, '').replace(/\r\n?/g, '\n').trim();

const toPage = <T>(items: T[], total: number, limit: number, offset: number): ArticlePage<T> => ({
  items,
  total,
  limit,
  offset,
  nextOffset: offset + items.length < total ? offset + items.length : null,
});

const toDto = (a: ArticleRow): KnowledgeArticleDto => ({
  id: a.id,
  title: a.title,
  body: a.body,
  category: a.category,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

const toAdminDto = (a: ArticleRow): AdminKnowledgeArticleDto => ({
  ...toDto(a),
  isPublished: a.isPublished,
});

const toSummary = (a: ArticleRow): KnowledgeArticleSummaryDto => ({
  id: a.id,
  title: a.title,
  category: a.category,
  updatedAt: a.updatedAt.toISOString(),
});

export interface ListFilter {
  categoryId?: string | undefined;
  /** Administrator list only: `true`/`false` narrows by publication state. */
  published?: boolean | undefined;
}

/**
 * Knowledge-base articles.
 *
 * Visibility is decided here, in the database query, and is independent of ticket permissions:
 *  - the reader API (`listPublished`/`getPublished`) only ever sees `isPublished = true`, for every
 *    role, so a draft or unpublished article answers 404 exactly like an id that does not exist;
 *  - the administrator API sees everything and is the only way to write.
 * Articles are never deleted: recommendations reference them (restrictive FK), and unpublishing
 * simply hides them from readers while the historical link stays intact.
 */
export function createKnowledgeService(prisma: PrismaClient) {
  const isCategoryActive = async (id: string) => {
    const c = await prisma.ticketCategory.findUnique({ where: { id }, select: { isActive: true } });
    return c?.isActive === true;
  };

  /** A category an article may be filed under: it must exist and be active. */
  const assertActiveCategory = async (categoryId: string | null | undefined) => {
    if (!categoryId) return;
    if (!(await isCategoryActive(categoryId))) {
      throw validationError('Category is unknown or inactive', {
        categoryId: ['Choose an active category'],
      });
    }
  };

  const loadForAdmin = async (id: string) => {
    const row = await articles.findArticle(prisma, id);
    if (!row) throw notFoundError('Article');
    return row;
  };

  return {
    // --- Readers: published only ---------------------------------------------------------------

    async listPublished(
      filter: ListFilter,
      limit: number,
      offset: number,
    ): Promise<ArticlePage<KnowledgeArticleSummaryDto>> {
      const { rows, total } = await articles.listArticles(
        prisma,
        { isPublished: true, ...(filter.categoryId ? { categoryId: filter.categoryId } : {}) },
        limit,
        offset,
      );
      return toPage(rows.map(toSummary), total, limit, offset);
    },

    /**
     * Ranked full-text search over published articles. This is the retrieval AI orchestration
     * calls too, so there is exactly one published-only search path.
     */
    async search(
      query: string,
      filter: { categoryId?: string | undefined },
      limit: number,
      offset: number,
    ): Promise<ArticlePage<KnowledgeSearchResultDto>> {
      const { hits, total } = await articles.searchPublished(prisma, {
        query,
        categoryId: filter.categoryId,
        limit,
        offset,
      });
      return toPage(hits, total, limit, offset);
    },

    /**
     * Filter choices for readers: active categories that currently have at least one published
     * article. Employees cannot read /api/categories, and this never reveals a category that only
     * holds drafts.
     */
    async listCategories(): Promise<CategoryRefDto[]> {
      const rows = await prisma.ticketCategory.findMany({
        where: { isActive: true, articles: { some: { isPublished: true } } },
        orderBy: { name: 'asc' },
      });
      return rows.map((c) => ({ id: c.id, name: c.name, description: c.description }));
    },

    async getPublished(id: string): Promise<KnowledgeArticleDto> {
      const row = await articles.findArticle(prisma, id);
      if (!row?.isPublished) throw notFoundError('Article');
      return toDto(row);
    },

    // --- Administrators ------------------------------------------------------------------------

    async listAll(
      filter: ListFilter,
      limit: number,
      offset: number,
    ): Promise<ArticlePage<AdminKnowledgeArticleSummaryDto>> {
      const { rows, total } = await articles.listArticles(
        prisma,
        {
          ...(filter.published === undefined ? {} : { isPublished: filter.published }),
          ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
        },
        limit,
        offset,
      );
      return toPage(
        rows.map((r) => ({ ...toSummary(r), isPublished: r.isPublished })),
        total,
        limit,
        offset,
      );
    },

    async getAny(id: string): Promise<AdminKnowledgeArticleDto> {
      return toAdminDto(await loadForAdmin(id));
    },

    async create(input: {
      title: string;
      body: string;
      categoryId?: string | null | undefined;
    }): Promise<AdminKnowledgeArticleDto> {
      const title = clean(input.title);
      const body = clean(input.body);
      if (!title || !body) throw validationError('Title and body must not be blank');
      await assertActiveCategory(input.categoryId);
      const created = await prisma.knowledgeArticle.create({
        data: { title, body, categoryId: input.categoryId ?? null, isPublished: false },
        include: articles.articleInclude,
      });
      return toAdminDto(created);
    },

    async update(
      id: string,
      input: {
        title?: string | undefined;
        body?: string | undefined;
        categoryId?: string | null | undefined;
      },
    ): Promise<AdminKnowledgeArticleDto> {
      await loadForAdmin(id);
      const title = input.title === undefined ? undefined : clean(input.title);
      const body = input.body === undefined ? undefined : clean(input.body);
      if (title === '' || body === '') throw validationError('Title and body must not be blank');
      if (input.categoryId !== undefined) await assertActiveCategory(input.categoryId);
      // One UPDATE statement: either every field changes or none does.
      const updated = await prisma.knowledgeArticle.update({
        where: { id },
        data: {
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          updatedAt: new Date(),
        },
        include: articles.articleInclude,
      });
      return toAdminDto(updated);
    },

    /** Idempotent: publishing a published article (or unpublishing a draft) is a no-op. */
    async setPublished(id: string, isPublished: boolean): Promise<AdminKnowledgeArticleDto> {
      const current = await loadForAdmin(id);
      if (current.isPublished === isPublished) return toAdminDto(current);
      if (isPublished && current.category && !(await isCategoryActive(current.category.id))) {
        throw new DbError('CONFLICT', 409, 'Assign an active category before publishing');
      }
      const updated = await prisma.knowledgeArticle.update({
        where: { id },
        data: { isPublished, updatedAt: new Date() },
        include: articles.articleInclude,
      });
      return toAdminDto(updated);
    },
  };
}
