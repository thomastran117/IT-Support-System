import { createPrisma, prismaCheck } from '@smartdesk/db';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;

// Runs only when a migrated database is provided (CI runs `npm run migrate` first).
describe.skipIf(!url)('database (integration)', () => {
  const prisma = createPrisma(url!);
  afterAll(() => prisma.$disconnect());

  it('is reachable through Prisma', async () => {
    expect(await prismaCheck(prisma)()).toBe(true);
  });

  it('has the baseline Prisma migration applied', async () => {
    const rows = await prisma.$queryRaw<
      { migration_name: string }[]
    >`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(rows.map((r) => r.migration_name)).toContain('0000_init');
  });
});
