import { SEARCH_QUERY_MAX } from '@smartdesk/contracts';
import { Prisma, type Db } from '@smartdesk/db';

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

export async function findArticle(db: Db, id: string): Promise<ArticleRow | null> {
  return db.knowledgeArticle.findUnique({ where: { id }, include: articleInclude });
}

// --- Full-text search (SD-030) -------------------------------------------------------------

export const SEARCH_PREVIEW_CHARS = 200;
const searchPreview = Prisma.sql`left(regexp_replace(a.body, '[[:space:]]+', ' ', 'g'), ${SEARCH_PREVIEW_CHARS + 1})`;

export function normalizeKnowledgeQuery(query: string): string {
  // NUL cannot be stored in or compared with PostgreSQL text.
  return query.replaceAll('\u0000', ' ').trim().slice(0, SEARCH_QUERY_MAX);
}

export interface SearchHit {
  id: string;
  title: string;
  category: { id: string; name: string } | null;
  preview: string;
  rank: number;
}

interface SearchArticle {
  id: string;
  title: string;
  category_id: string | null;
  category_name: string | null;
  preview: string;
}

interface SearchRow extends SearchArticle {
  revision: number;
  rank: number;
  total: bigint;
}

export interface PublishedSearchOptions {
  query: string;
  categoryId?: string | undefined;
  limit: number;
  offset: number;
}

export interface PublishedSearchResult {
  hits: SearchHit[];
  total: number;
  revisions: ReadonlyMap<string, number>;
}

function toSearchArticle(row: SearchArticle): Omit<SearchHit, 'rank'> {
  return {
    id: row.id,
    title: row.title,
    category: row.category_id ? { id: row.category_id, name: row.category_name ?? '' } : null,
    preview:
      row.preview.length > SEARCH_PREVIEW_CHARS
        ? `${row.preview.slice(0, SEARCH_PREVIEW_CHARS).trimEnd()}…`
        : row.preview,
  };
}

/** Current revisions and previews for published candidates, all read in one PostgreSQL statement. */
export async function loadPublishedSearchArticles(db: Db, ids: string[], categoryId?: string) {
  if (ids.length === 0) return [];
  const category = categoryId ?? null;
  const rows = await db.$queryRaw<(SearchArticle & { revision: number })[]>`
    SELECT a.article_id AS id, a.title, a.category_id, c.name AS category_name,
           ${searchPreview} AS preview, a.search_revision AS revision
    FROM knowledge_articles a
    LEFT JOIN ticket_categories c ON c.category_id = a.category_id
    WHERE a.is_published
      AND a.article_id = ANY(${ids}::uuid[])
      AND (${category}::uuid IS NULL OR a.category_id = ${category}::uuid)`;
  return rows.map((row) => ({ ...toSearchArticle(row), revision: row.revision }));
}

/**
 * PostgreSQL full-text retrieval over published articles.
 *
 * - `websearch_to_tsquery` never raises on odd input: quotes, `&`, `|`, `:*`, `'`, `\` and SQL
 *   fragments are parsed as search syntax or dropped, never executed. The text is a bound
 *   parameter; nothing is concatenated into the SQL.
 * - Matching uses the same expression as `idx_knowledge_articles_fts` (partial, `is_published`).
 * - Rank: weighted `ts_rank_cd` with title (A) above body (B), then newest, then id: total order.
 * - A blank query, or one with no searchable terms (e.g. only punctuation), returns no rows.
 */
export async function searchPublished(
  db: Db,
  opts: PublishedSearchOptions,
): Promise<PublishedSearchResult> {
  const q = normalizeKnowledgeQuery(opts.query);
  if (!q) return { hits: [], total: 0, revisions: new Map() };
  const category = opts.categoryId ?? null;

  const rows = await db.$queryRaw<SearchRow[]>`
    WITH q AS (SELECT websearch_to_tsquery('english'::regconfig, ${q}) AS tsq)
    SELECT a.article_id AS id,
           a.title,
           a.category_id,
           c.name AS category_name,
           a.search_revision AS revision,
           ${searchPreview} AS preview,
           ts_rank_cd(
             setweight(to_tsvector('english'::regconfig, a.title), 'A') ||
             setweight(to_tsvector('english'::regconfig, a.body), 'B'),
             q.tsq
           )::float8 AS rank,
           count(*) OVER () AS total
    FROM knowledge_articles a
    CROSS JOIN q
    LEFT JOIN ticket_categories c ON c.category_id = a.category_id
    WHERE a.is_published
      AND to_tsvector('english'::regconfig, a.title || ' ' || a.body) @@ q.tsq
      AND (${category}::uuid IS NULL OR a.category_id = ${category}::uuid)
    ORDER BY rank DESC, a.updated_at DESC, a.article_id ASC
    LIMIT ${opts.limit} OFFSET ${opts.offset}`;

  let total = rows[0] ? Number(rows[0].total) : 0;
  if (rows.length === 0 && opts.offset > 0) {
    // A page past the end carries no window total; ask for the count so callers can still show it.
    const [row] = await db.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total
      FROM knowledge_articles a
      WHERE a.is_published
        AND to_tsvector('english'::regconfig, a.title || ' ' || a.body)
            @@ websearch_to_tsquery('english'::regconfig, ${q})
        AND (${category}::uuid IS NULL OR a.category_id = ${category}::uuid)`;
    total = Number(row?.total ?? 0);
  }
  return {
    total,
    hits: rows.map((row) => ({ ...toSearchArticle(row), rank: row.rank })),
    revisions: new Map(rows.map((row) => [row.id, row.revision])),
  };
}
