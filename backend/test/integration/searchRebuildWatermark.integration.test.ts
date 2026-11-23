import { afterAll, describe, expect, it } from 'vitest';
import { enqueueSearchIndexJob } from '../../src/db/repositories/searchIndexJobs.js';
import { sealSearchOutbox } from '../../src/db/repositories/searchRebuilds.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('search outbox watermark', () => {
  const prisma = createTestPrisma();
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('waits for a lower sequence that has not committed and includes the closed prefix', async () => {
    await resetDatabase(prisma);
    const inserted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = (suffix: string) => ({
      entityType: 'TICKET' as const,
      entityId: `00000000-0000-4000-8000-000000000${suffix}`,
      revision: 1,
      eventKind: 'UPSERT' as const,
    });
    const first = prisma.$transaction(
      async (tx) => {
        await enqueueSearchIndexJob(tx, write('001'));
        inserted.resolve();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    let sealing: Promise<bigint> | undefined;
    try {
      await inserted.promise;
      await prisma.$transaction((tx) => enqueueSearchIndexJob(tx, write('002')));
      const [visible] = await prisma.searchIndexJob.findMany();
      expect(visible).toMatchObject({ sequence: 2n });
      sealing = prisma.$transaction(sealSearchOutbox, { timeout: 10_000 });
      await expect
        .poll(async () => {
          const [row] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation = 'search_index_jobs'::regclass
            AND mode = 'ShareLock' AND NOT granted) AS waiting`;
          return row?.waiting;
        })
        .toBe(true);
      release.resolve();
      await first;
      const watermark = await sealing;
      await prisma.$transaction((tx) => enqueueSearchIndexJob(tx, write('003')));
      expect(watermark).toBe(2n);
      expect(
        await prisma.searchIndexJob.findMany({
          where: { sequence: { lte: watermark } },
          orderBy: { sequence: 'asc' },
          select: { sequence: true },
        }),
      ).toEqual([{ sequence: 1n }, { sequence: 2n }]);
    } finally {
      release.resolve();
      await Promise.allSettled([first, sealing]);
    }
  }, 15_000);
});
