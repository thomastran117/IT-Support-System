import {
  redactText,
  RETRIEVAL_LIMIT,
  truncate,
  type KnowledgeRetrieval,
} from '@smartdesk/ai-analysis';
import type { Db } from '@smartdesk/db';
import { searchPublished, type PublishedSearchResult } from './repository.js';

interface RetrievalQuery {
  query: string[];
  limit: number;
  offset: number;
  signal: AbortSignal;
}

export function createPublishedRetrieval(
  db: Db,
  search: (
    opts: RetrievalQuery,
  ) => Promise<
    PublishedSearchResult & { engine: KnowledgeRetrieval['retrieval']['engine'] }
  > = async ({ query, limit, offset }) => ({
    ...(await searchPublished(db, { query: query.join(' or '), limit, offset })),
    engine: query.length ? 'postgres' : 'none',
  }),
) {
  return async (terms: string[]): Promise<KnowledgeRetrieval> => {
    const { hits, revisions, engine } = await search({
      query: terms,
      limit: RETRIEVAL_LIMIT,
      offset: 0,
      signal: AbortSignal.timeout(1500),
    });
    const rows = hits.length
      ? await db.knowledgeArticle.findMany({
          where: { id: { in: hits.map((hit) => hit.id) }, isPublished: true },
          select: { id: true, title: true, body: true, searchRevision: true },
        })
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Re-read publication and revision before sending content, and keep ranked order.
    const articles = hits.flatMap(({ id }) => {
      const row = byId.get(id);
      if (!row || row.searchRevision !== revisions.get(id)) return [];
      return [
        {
          id,
          title: truncate(redactText(row.title), 200),
          body: truncate(redactText(row.body), 1500),
        },
      ];
    });
    return { articles, retrieval: { engine, version: 1 } };
  };
}
