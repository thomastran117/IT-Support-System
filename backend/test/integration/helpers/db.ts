import { createPrisma, type PrismaClient } from '@smartdesk/db';
import { expect } from 'vitest';

export const CORE_TABLES = [
  'ai_recommendations',
  'classification_labels',
  'knowledge_articles',
  'recommendation_articles',
  'support_teams',
  'team_members',
  'ticket_categories',
  'ticket_comments',
  'ticket_events',
  'tickets',
  'users',
] as const;

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Integration tests wipe tables, so refuse to run against anything that does not look like a
 * disposable test database.
 */
export function createTestPrisma(): PrismaClient {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set');
  const dbName = new URL(testDatabaseUrl).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": database name must contain "test"`);
  }
  return createPrisma(testDatabaseUrl);
}

/** Remove all rows. TRUNCATE is not a row operation, so the audit trigger does not block it. */
export function resetDatabase(prisma: PrismaClient): Promise<number> {
  return prisma.$executeRawUnsafe(
    `TRUNCATE ${CORE_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

type Row = Record<string, unknown>;

/** Insert one row with raw SQL (no Prisma validation) and return it. Values are bound params. */
export async function insertRow(prisma: PrismaClient, table: string, values: Row): Promise<Row> {
  const cols = Object.keys(values);
  const params = cols.map((_, i) => `$${i + 1}`);
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${params.join(', ')}) RETURNING *`,
    ...cols.map((c) => values[c]),
  );
  return rows[0]!;
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof Error) parts.push(cur.message);
    const meta = (cur as { meta?: unknown }).meta;
    if (meta) parts.push(JSON.stringify(meta));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** Assert a statement is rejected by the database, optionally naming the violated constraint. */
export async function expectViolation(
  statement: Promise<unknown>,
  constraint?: string,
): Promise<void> {
  let failure: unknown;
  try {
    await statement;
  } catch (err) {
    failure = err;
  }
  expect(failure, 'statement should have been rejected').toBeDefined();
  if (constraint) expect(errorText(failure)).toContain(constraint);
}
