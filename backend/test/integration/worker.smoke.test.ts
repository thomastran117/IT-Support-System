import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueAnalysis, findLatestForTicket } from '../../src/db/repositories/aiAnalysisJobs.js';
import { TICKETS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('worker process (integration)', () => {
  const prisma = createTestPrisma();
  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('picks up a job queued before it started, completes it and exits on SIGTERM', async () => {
    // Queued while no worker was running.
    await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });

    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl,
        AI_PROVIDER: 'fake',
        WORKER_POLL_INTERVAL_MS: '100',
      },
      stdio: 'ignore',
    });
    try {
      await expect
        .poll(async () => (await findLatestForTicket(prisma, TICKETS.printer))?.state, {
          timeout: 20_000,
          interval: 250,
        })
        .toBe('COMPLETED');
    } finally {
      child.kill('SIGTERM');
      const [code, signal] = await once(child, 'exit');
      // On Windows SIGTERM terminates the process without running handlers.
      expect(code === 0 || signal === 'SIGTERM').toBe(true);
    }
  }, 40_000);
});
