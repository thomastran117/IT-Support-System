import { createPrisma, type PrismaClient } from '@smartdesk/db';

/**
 * Process-wide Prisma client. One connection pool per process (API or worker), created at
 * startup and closed on shutdown. Never create a client per HTTP request.
 */
let instance: PrismaClient | undefined;

/** Create the client once. Calling again returns the existing instance. */
export function initPrisma(databaseUrl: string): PrismaClient {
  instance ??= createPrisma(databaseUrl);
  return instance;
}

export function getPrisma(): PrismaClient {
  if (!instance) throw new Error('Database client is not initialised; call initPrisma() first');
  return instance;
}

/** Graceful shutdown: drains the pool. Safe to call more than once. */
export async function closePrisma(): Promise<void> {
  const client = instance;
  instance = undefined;
  if (client) await client.$disconnect();
}
