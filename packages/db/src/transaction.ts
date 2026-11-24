import type { Prisma, PrismaClient, TransactionClient } from './index.js';

export type Db = PrismaClient | TransactionClient;
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
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
 * - The caller decides how to translate the final error.
 */
export async function runTransaction<T>(
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
      throw err;
    }
  }
}
