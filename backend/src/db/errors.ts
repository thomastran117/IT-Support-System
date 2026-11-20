import { HttpError } from '../plugins/errors.js';

export type DbErrorCode =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STALE_WRITE'
  | 'LIFECYCLE'
  | 'REFERENCE'
  | 'CONSTRAINT'
  | 'RETRYABLE'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

/**
 * Typed database/domain failure. Messages are safe to return to clients: they never contain SQL,
 * connection strings, constraint names or row data.
 */
export class DbError extends HttpError {
  constructor(
    public readonly code: DbErrorCode,
    statusCode: number,
    message: string,
    details: unknown = null,
  ) {
    super(statusCode, message, details);
    this.name = 'DbError';
  }
}

export const validationError = (message: string, details?: unknown) =>
  new DbError('VALIDATION', 422, message, details ?? null);
export const forbiddenError = (message = 'You are not allowed to perform this action') =>
  new DbError('FORBIDDEN', 403, message);
export const notFoundError = (what: string) => new DbError('NOT_FOUND', 404, `${what} not found`);
export const lifecycleError = (message: string) => new DbError('LIFECYCLE', 409, message);
export const staleWriteError = (what: string) =>
  new DbError('STALE_WRITE', 409, `${what} was changed by someone else. Reload it and try again.`);

// PostgreSQL SQLSTATE classes we translate.
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const CHECK = '23514';
const NOT_NULL = '23502';
const RESTRICT = '23001';
const SERIALIZATION = '40001';
const DEADLOCK = '40P01';

/** Pull a PostgreSQL SQLSTATE out of the various shapes Prisma / the pg adapter produce. */
export function sqlState(err: unknown): string | undefined {
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
    message?: string;
  };
  const adapterCode = e?.meta?.driverAdapterError?.cause?.originalCode;
  if (adapterCode) return adapterCode;
  if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && !/^P\d{4}$/.test(e.code)) {
    return e.code;
  }
  switch (e?.code) {
    case 'P2002':
      return UNIQUE;
    case 'P2003':
      return FOREIGN_KEY;
    case 'P2034':
      return SERIALIZATION;
    default:
  }
  const fromMessage = /Code: `([0-9A-Z]{5})`/.exec(e?.message ?? '');
  return fromMessage?.[1];
}

/** True when retrying the whole transaction can succeed (serialization failure or deadlock). */
export function isRetryable(err: unknown): boolean {
  const state = sqlState(err);
  return state === SERIALIZATION || state === DEADLOCK;
}

const CONNECTION_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

/** Translate any thrown value into a {@link DbError}. Already-typed errors pass through. */
export function mapDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const code = (err as { code?: string })?.code;
  const state = sqlState(err);

  if (state === UNIQUE)
    return new DbError('CONFLICT', 409, 'A record with these values already exists');
  if (state === FOREIGN_KEY || state === RESTRICT) {
    return new DbError(
      'REFERENCE',
      409,
      'The request references a record that does not exist or is still in use',
    );
  }
  if (state === CHECK || state === NOT_NULL) {
    return new DbError('CONSTRAINT', 422, 'The request violates a data integrity rule');
  }
  if (state === SERIALIZATION || state === DEADLOCK) {
    return new DbError(
      'RETRYABLE',
      409,
      'The operation conflicted with another one. Please retry.',
    );
  }
  if (code === 'P2025') return notFoundError('Record');
  if (code === 'P2028') return new DbError('TIMEOUT', 503, 'The database operation took too long');
  if (code && CONNECTION_CODES.has(code)) {
    return new DbError('UNAVAILABLE', 503, 'The database is temporarily unavailable');
  }
  const name = (err as { name?: string })?.name ?? '';
  if (/Initialization/.test(name)) {
    return new DbError('UNAVAILABLE', 503, 'The database is temporarily unavailable');
  }
  return new DbError('UNKNOWN', 500, 'Internal server error');
}
