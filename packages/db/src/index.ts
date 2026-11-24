import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/client.js';

export { Prisma, PrismaClient };

/** The client handed to `$transaction` callbacks. */
export type TransactionClient = Prisma.TransactionClient;
export {
  enqueueSearchIndexJob,
  type SearchIndexEntityType,
  type SearchIndexEventKind,
} from './searchIndexIntents.js';

export {
  isRetryable,
  runTransaction,
  sqlState,
  type Db,
  type TransactionOptions,
} from './transaction.js';

export const DEFAULT_DATABASE_URL = 'postgresql://smartdesk:smartdesk@localhost:5432/smartdesk';

/** Create a Prisma client backed by the pg driver adapter. Call `$disconnect()` on shutdown. */
export function createPrisma(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  return new PrismaClient({ adapter });
}

export type DbCheck = () => Promise<boolean>;

/** Readiness probe: true when a trivial query succeeds. */
export function prismaCheck(prisma: PrismaClient): DbCheck {
  return async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  };
}
