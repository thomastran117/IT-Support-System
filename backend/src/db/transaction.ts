import { Prisma, type PrismaClient, type TransactionClient } from '@smartdesk/db';
import { isRetryable, mapDbError } from './errors.js';

/** Either the shared client or a transaction handle; repositories accept both. */
export type Db = PrismaClient | TransactionClient;

export interface TransactionOptions {
  /** Max time to wait for a pooled connection. Default 5 s. */
  maxWaitMs?: number;
  /** Max time the transaction may run before PostgreSQL rolls it back. Default 10 s. */
  timeoutMs?: number;
  /** Extra attempts after a serialization failure or deadlock. Default 2. */
  retries?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `work` atomically. Everything it writes commits together or not at all.
 *
 * - Duration is bounded (`timeoutMs`), so a stuck request cannot hold locks forever.
 * - Serialization failures and deadlocks are retried with a short backoff.
 * - Every failure leaves as a safe `DbError` (no SQL, no connection details).
 */
export async function withTransaction<T>(
  prisma: PrismaClient,
  work: (tx: TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const { maxWaitMs = 5_000, timeoutMs = 10_000, retries = 2, isolationLevel } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, {
        maxWait: maxWaitMs,
        timeout: timeoutMs,
        ...(isolationLevel ? { isolationLevel } : {}),
      });
    } catch (err) {
      if (attempt < retries && isRetryable(err)) {
        await sleep(25 * 2 ** attempt + Math.floor(Math.random() * 25));
        continue;
      }
      throw mapDbError(err);
    }
  }
}

/**
 * Concurrency strategy: pessimistic row locks. Mutating services call `lockRow` first, which
 * takes `SELECT ... FOR UPDATE` inside the transaction, so concurrent writers to the same
 * ticket/recommendation queue up and see each other's committed state. Callers may also pass the
 * `updatedAt` they last read; a mismatch is surfaced as a 409 stale-write instead of a silent
 * last-write-wins.
 */
export async function lockRow(
  tx: TransactionClient,
  table: 'tickets' | 'ai_recommendations',
  id: string,
): Promise<boolean> {
  const idColumn = table === 'tickets' ? 'ticket_id' : 'recommendation_id';
  const rows = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE ${Prisma.raw(`"${idColumn}"`)} = ${id}::uuid FOR UPDATE`,
  );
  return rows.length > 0;
}
