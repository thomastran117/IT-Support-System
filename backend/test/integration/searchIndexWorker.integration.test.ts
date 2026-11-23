import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimSearchIndexJobs,
  completeSearchIndexJob,
  failSearchIndexJob,
  requeueFailedSearchIndexJob,
} from '../../src/db/repositories/searchIndexJobs.js';
import { USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { submitTicket } from '../../src/db/services/ticketService.js';
import { createKnowledgeService } from '../../src/modules/knowledge/service.js';
import { createSearchBulkClient, type SearchBulkClient } from '../../src/modules/search/bulk.js';
import { createSearchIndexWorker } from '../../src/modules/search/indexWorker.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const config = { enabled: true, url: 'http://search.example.test/' } as const;

function bulkResult(init: RequestInit | undefined, status: (id: string) => number): Response {
  const items = String(init?.body)
    .trimEnd()
    .split('\n')
    .filter((_, i) => i % 2 === 0)
    .map((line) => {
      const {
        index: { _id },
      } = JSON.parse(line);
      return {
        index: {
          _id,
          status: status(_id),
          error: { type: 'error', reason: 'upstream private text' },
        },
      };
    });
  return Response.json({ items });
}

describe.skipIf(!testDatabaseUrl)('search indexing queue and worker', () => {
  const prisma = createTestPrisma();
  let now: Date;
  const submit = (title: string) =>
    submitTicket(prisma, {
      requesterId: USERS.erin,
      title,
      description: 'Canonical source body',
    });
  const jobFor = (entityId: string) =>
    prisma.searchIndexJob.findFirstOrThrow({ where: { entityId } });
  const setupWorker = (bulk: SearchBulkClient, log?: (entry: unknown) => void) =>
    createSearchIndexWorker({
      prisma,
      bulk,
      pollIntervalMs: 100,
      now: () => now,
      random: () => 0.5,
      log,
    });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    now = new Date(Date.now() + 10_000);
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('keeps database writes available and retries HTTP 429 and per-item 503 with bounded backoff', async () => {
    const { ticket } = await submit('Before search outage');
    const send = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('upstream private text', { status: 429 }))
      .mockImplementationOnce(async (_url, init) => bulkResult(init, () => 503))
      .mockImplementation(async (_url, init) => bulkResult(init, () => 201));
    const logs: unknown[] = [];
    const worker = setupWorker(createSearchBulkClient(config, { fetch: send })!, (entry) =>
      logs.push(entry),
    );

    await worker.runOnce();
    const firstRetry = await jobFor(ticket.id);
    expect(firstRetry).toMatchObject({
      state: 'QUEUED',
      attempts: 1,
      errorKind: 'rate_limited',
      leaseToken: null,
    });
    expect(firstRetry.availableAt.getTime() - now.getTime()).toBe(5_625);
    await worker.runOnce();
    expect(send).toHaveBeenCalledTimes(1);

    // This ticket and its outbox transaction succeed while the downstream node is unavailable.
    const { ticket: during } = await submit('During search outage');
    expect(await jobFor(during.id)).toMatchObject({ state: 'QUEUED', attempts: 0 });
    now = firstRetry.availableAt;
    await worker.runOnce();
    const secondRetry = await jobFor(ticket.id);
    expect(secondRetry).toMatchObject({ state: 'QUEUED', attempts: 2, errorKind: 'unavailable' });
    expect(secondRetry.availableAt.getTime() - now.getTime()).toBe(11_250);
    now = secondRetry.availableAt;
    await worker.runOnce();
    expect(await jobFor(ticket.id)).toMatchObject({
      state: 'COMPLETED',
      attempts: 3,
      errorKind: null,
    });
    expect(await jobFor(during.id)).toMatchObject({ state: 'COMPLETED', attempts: 2 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(logs)).not.toMatch(/private text|Canonical source body/);
  });

  it('settles mixed bulk results independently and requeues only an explicitly selected failed job', async () => {
    const { ticket } = await submit('Rejected mapping');
    const knowledge = createKnowledgeService(prisma);
    const draft = await knowledge.create({ title: 'Knowledge', body: 'Published steps' });
    await knowledge.setPublished(draft.id, true);
    const send = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) =>
        bulkResult(init, (id) => (id === ticket.id ? 400 : 201)),
      )
      .mockImplementation(async (_url, init) => bulkResult(init, () => 201));
    const worker = setupWorker(createSearchBulkClient(config, { fetch: send })!);
    await worker.runOnce();
    const failed = await jobFor(ticket.id);
    const completed = await jobFor(draft.id);
    expect(failed).toMatchObject({ state: 'FAILED', attempts: 1, errorKind: 'rejected' });
    expect(completed).toMatchObject({ state: 'COMPLETED', attempts: 1 });
    expect(await requeueFailedSearchIndexJob(prisma, completed.id)).toBe(0);
    expect(await requeueFailedSearchIndexJob(prisma, failed.id)).toBe(1);
    expect(await jobFor(ticket.id)).toMatchObject({
      state: 'QUEUED',
      attempts: 0,
      completedAt: null,
    });
    await worker.runOnce();
    expect(await jobFor(ticket.id)).toMatchObject({ state: 'COMPLETED', attempts: 1 });
  });

  it('ends a retryable failure at the attempt limit', async () => {
    const { ticket } = await submit('Persistent outage');
    const job = await jobFor(ticket.id);
    await prisma.searchIndexJob.update({ where: { id: job.id }, data: { maxAttempts: 1 } });
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const worker = setupWorker(createSearchBulkClient(config, { fetch: send })!);
    await worker.runOnce();
    now = new Date(now.getTime() + 60_000);
    await worker.runOnce();
    expect(await jobFor(ticket.id)).toMatchObject({
      state: 'FAILED',
      attempts: 1,
      leaseToken: null,
      completedAt: expect.any(Date),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('splits concurrent claims, recovers expired leases and fences off stale settlements', async () => {
    await submit('First lease');
    await submit('Second lease');
    const claim = () => claimSearchIndexJobs(prisma, { limit: 1, leaseMs: 100, now });
    const [[first], [second]] = await Promise.all([claim(), claim()]);
    expect(first?.id).not.toBe(second?.id);
    expect(await claim()).toEqual([]);
    await prisma.searchIndexJob.update({ where: { id: second!.id }, data: { maxAttempts: 1 } });
    now = new Date(now.getTime() + 100);
    const [reclaimed] = await claim();
    expect(reclaimed).toMatchObject({ id: first!.id, attempts: 2 });
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);
    expect(await completeSearchIndexJob(prisma, first!, now)).toBe(0);
    expect(await failSearchIndexJob(prisma, first!, 'unavailable', null, now)).toBe(0);
    expect(await completeSearchIndexJob(prisma, reclaimed!, now)).toBe(1);
    expect(await jobFor(second!.entityId)).toMatchObject({
      state: 'FAILED',
      errorKind: 'worker_lost',
      lockedUntil: null,
    });
  });

  it('drains the in-flight batch on shutdown and leaves subsequent work queued', async () => {
    const { ticket } = await submit('In flight');
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const worker = setupWorker({
      async write(writes) {
        started.resolve();
        await release.promise;
        return writes.map(() => ({ ok: true }));
      },
    });
    worker.start();
    try {
      await started.promise;
      const { ticket: next } = await submit('Next batch');
      const stop = worker.stop();
      release.resolve();
      await stop;
      expect(await jobFor(ticket.id)).toMatchObject({ state: 'COMPLETED' });
      expect(await jobFor(next.id)).toMatchObject({ state: 'QUEUED', attempts: 0 });
    } finally {
      release.resolve();
      await worker.stop();
    }
  });
});
