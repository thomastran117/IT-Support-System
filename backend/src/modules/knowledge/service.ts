import type { Prisma, PrismaClient, TransactionClient } from '@smartdesk/db';
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
import {
  enqueueSearchIndexJob,
  type SearchIndexEventKind,
} from '../../db/repositories/searchIndexJobs.js';
import { withTransaction, type Db } from '../../db/transaction.js';

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
  const isCategoryActive = async (id: string, db: Db = prisma) => {
    const c = await db.ticketCategory.findUnique({ where: { id }, select: { isActive: true } });
    return c?.isActive === true;
  };

  /** A category an article may be filed under: it must exist and be active. */
  const assertActiveCategory = async (categoryId: string | null | undefined, db: Db = prisma) => {
    if (!categoryId) return;
    if (!(await isCategoryActive(categoryId, db))) {
      throw validationError('Category is unknown or inactive', {
        categoryId: ['Choose an active category'],
      });
    }
  };

  const loadForAdmin = async (id: string, db: Db = prisma) => {
    const row = await articles.findArticle(db, id);
    if (!row) throw notFoundError('Article');
    return row;
  };

  const loadForWrite = async (tx: TransactionClient, id: string) => {
    // Serialize the visibility/content comparison with concurrent writes to this article.
    await tx.$queryRaw`SELECT 1 FROM knowledge_articles WHERE article_id = ${id}::uuid FOR NO KEY UPDATE`;
    return loadForAdmin(id, tx);
  };

  const save = async (
    tx: TransactionClient,
    id: string,
    data: Pick<
      Prisma.KnowledgeArticleUncheckedUpdateInput,
      'title' | 'body' | 'categoryId' | 'isPublished'
    >,
    eventKind?: SearchIndexEventKind,
  ) => {
    const updated = await tx.knowledgeArticle.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date(),
        ...(eventKind && { searchRevision: { increment: 1 } }),
      },
      include: articles.articleInclude,
    });
    if (eventKind) {
      await enqueueSearchIndexJob(tx, {
        entityType: 'KNOWLEDGE_ARTICLE',
        entityId: id,
        revision: updated.searchRevision,
        eventKind,
      });
    }
    return toAdminDto(updated);
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
      return withTransaction(prisma, async (tx) => {
        const current = await loadForWrite(tx, id);
        const title = input.title === undefined ? undefined : clean(input.title);
        const body = input.body === undefined ? undefined : clean(input.body);
        const categoryId = input.categoryId;
        if (title === '' || body === '') throw validationError('Title and body must not be blank');
        if (categoryId !== undefined) await assertActiveCategory(categoryId, tx);
        const changed =
          (title !== undefined && title !== current.title) ||
          (body !== undefined && body !== current.body) ||
          (categoryId !== undefined && categoryId !== current.categoryId);
        return save(
          tx,
          id,
          {
            ...(title === undefined ? {} : { title }),
            ...(body === undefined ? {} : { body }),
            ...(categoryId === undefined ? {} : { categoryId }),
          },
          current.isPublished && changed ? 'UPSERT' : undefined,
        );
      });
    },

    /** Idempotent: publishing a published article (or unpublishing a draft) is a no-op. */
    async setPublished(id: string, isPublished: boolean): Promise<AdminKnowledgeArticleDto> {
      return withTransaction(prisma, async (tx) => {
        const current = await loadForWrite(tx, id);
        if (current.isPublished === isPublished) return toAdminDto(current);
        if (
          isPublished &&
          current.categoryId &&
          !(await isCategoryActive(current.categoryId, tx))
        ) {
          throw new DbError('CONFLICT', 409, 'Assign an active category before publishing');
        }
        return save(tx, id, { isPublished }, isPublished ? 'UPSERT' : 'DELETE');
      });
    },
  };
}
