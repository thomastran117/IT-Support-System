import type { Prisma } from '@smartdesk/db';
import type { Db } from '../transaction.js';

export const articleInclude = { category: { select: { id: true, name: true } } } as const;

export type ArticleRow = Prisma.KnowledgeArticleGetPayload<{ include: typeof articleInclude }>;

/** Page through articles. `where` is built by the caller; published-only is the caller's job. */
export async function listArticles(
  db: Db,
  where: Prisma.KnowledgeArticleWhereInput,
  limit: number,
  offset: number,
): Promise<{ rows: ArticleRow[]; total: number }> {
  const [rows, total] = await Promise.all([
    db.knowledgeArticle.findMany({
      where,
      include: articleInclude,
      // `id` makes the order total, so pages never repeat or skip rows.
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset,
    }),
    db.knowledgeArticle.count({ where }),
  ]);
  return { rows, total };
}

export const findArticle = (db: Db, id: string) =>
  db.knowledgeArticle.findUnique({ where: { id }, include: articleInclude });
