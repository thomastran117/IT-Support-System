import type { PrismaClient, TransactionClient } from './index.js';
import { runTransaction, sqlState, type TransactionOptions } from './transaction.js';
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
  }
}

export type DbErrorCode =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STALE_WRITE'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'PREREQUISITE_FAILED'
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
/** The optimistic concurrency check failed: the ticket changed since the caller read it. */
export const versionConflictError = (currentVersion: number | null) =>
  new DbError(
    'VERSION_CONFLICT',
    409,
    'Ticket was changed by someone else. Reload it and try again.',
    { currentVersion },
  );
export const invalidTransitionError = (from: string, to: string) =>
  new DbError('INVALID_TRANSITION', 409, `A ${from} ticket cannot move to ${to}`, { from, to });
export const prerequisiteError = (to: string, missing: readonly string[]) =>
  new DbError('PREREQUISITE_FAILED', 409, `Cannot move to ${to}: prerequisites are not met`, {
    to,
    missing,
  });
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

export { isRetryable, sqlState } from './transaction.js';

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

export async function withTransaction<T>(
  prisma: PrismaClient,
  work: (tx: TransactionClient) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  try {
    return await runTransaction(prisma, work, options);
  } catch (error) {
    throw mapDbError(error);
  }
}
