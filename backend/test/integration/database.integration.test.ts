import { readdirSync } from 'node:fs';
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

  it('has every committed migration applied exactly once, with none failed or unknown', async () => {
    const committed = readdirSync(new URL('../../prisma/migrations/', import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(committed[0]).toBe('0000_init');
    const rows = await prisma.$queryRaw<
      { migration_name: string; finished: boolean; rolled_back: boolean }[]
    >`SELECT migration_name, finished_at IS NOT NULL AS finished,
             rolled_back_at IS NOT NULL AS rolled_back
      FROM _prisma_migrations`;
    expect(rows.filter((r) => !r.finished || r.rolled_back)).toEqual([]);
    expect(rows.map((r) => r.migration_name).sort()).toEqual(committed);
  });
});
