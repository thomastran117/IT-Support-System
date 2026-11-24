import {
  runTransaction,
  type PrismaClient,
  type TransactionClient,
  type TransactionOptions,
} from '@smartdesk/db';
import { mapDbError } from './errors.js';

export type { Db, TransactionOptions } from '@smartdesk/db';

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
