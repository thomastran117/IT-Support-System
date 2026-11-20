import type { Db } from '../transaction.js';

/** Link published knowledge articles to a recommendation, ranked 1..n in the order given. */
export const linkArticles = (db: Db, recommendationId: string, articleIds: string[]) =>
  db.recommendationArticle.createMany({
    data: articleIds.map((articleId, i) => ({ recommendationId, articleId, relevanceRank: i + 1 })),
  });

export const listLinkedArticles = (db: Db, recommendationId: string) =>
  db.recommendationArticle.findMany({
    where: { recommendationId },
    orderBy: { relevanceRank: 'asc' },
  });
