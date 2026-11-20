import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validationError } from './errors.js';

/** Version-controlled SQL lives in backend/sql; the same relative path works from src/ and dist/. */
const SQL_ROOT = fileURLToPath(new URL('../../sql/', import.meta.url));

const cache = new Map<string, string>();

/** Load a `.sql` file by path relative to backend/sql (e.g. `queries/Q01_….sql`). */
export function loadSql(relativePath: string): string {
  let sql = cache.get(relativePath);
  if (!sql) {
    sql = readFileSync(`${SQL_ROOT}${relativePath}`, 'utf8');
    cache.set(relativePath, sql);
  }
  return sql;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  limit?: number;
  offset?: number;
}

/** Validate and bound pagination: limit 1..MAX_PAGE_SIZE (larger values are capped), offset >= 0. */
export function normalizePage(page: PageRequest = {}): { limit: number; offset: number } {
  const limit = page.limit ?? DEFAULT_PAGE_SIZE;
  const offset = page.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1)
    throw validationError('limit must be a positive integer');
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationError('offset must be a non-negative integer');
  }
  return { limit: Math.min(limit, MAX_PAGE_SIZE), offset };
}

/**
 * Append bound LIMIT/OFFSET placeholders to a stored query without touching its ORDER BY, so the
 * documented ordering and tie-breakers are preserved. `paramCount` is how many `$n` it already uses.
 */
export function paginated(sql: string, paramCount: number): string {
  const body = sql.replace(/\s*;\s*$/, '');
  return `${body} LIMIT $${paramCount + 1}::int OFFSET $${paramCount + 2}::int`;
}
