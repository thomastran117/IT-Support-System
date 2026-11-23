import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSearchIndexJob } from '../../src/db/repositories/searchIndexJobs.js';
import { USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { submitTicket } from '../../src/db/services/ticketService.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createKnowledgeService } from '../../src/modules/knowledge/service.js';
import { createSearchBulkClient, type SearchIndexWrite } from '../../src/modules/search/bulk.js';
import { createSearchClient } from '../../src/modules/search/client.js';
import { searchIndexes } from '../../src/modules/search/indexes.js';
import { createSearchIndexWorker } from '../../src/modules/search/indexWorker.js';
import { initializeSearchIndexes } from '../../src/modules/search/initialize.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const testUrl = process.env.TEST_OPENSEARCH_URL;

describe.skipIf(!testDatabaseUrl || !testUrl)('search indexing with real OpenSearch', () => {
  const prisma = createTestPrisma();
  const config = { enabled: true, url: testUrl ?? 'http://search.invalid/' } as const;
  const bulk = createSearchBulkClient(config)!;
  const search = createSearchClient(config, { timeoutMs: 3_000 })!;
  const raw = (path: string, method = 'GET') =>
    fetch(new URL(path, config.url), { method, signal: AbortSignal.timeout(5_000) });
  const find = { query: { match_all: {} }, size: 25 };
  let ownsIndexes = false;
  let now: Date;

  beforeAll(async () => {
    for (const index of Object.values(searchIndexes)) {
      expect((await raw(index.name, 'HEAD')).status).toBe(404);
      const aliases = await raw(`_alias/${index.aliasPattern}?expand_wildcards=all`);
      expect(aliases.status).toBe(200);
      expect(await aliases.json()).toEqual({});
    }
    ownsIndexes = true;
    await initializeSearchIndexes(config);
  }, 15_000);

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    now = new Date(Date.now() + 10_000);
  });

  afterAll(async () => {
    if (ownsIndexes) {
      for (const index of Object.values(searchIndexes)) {
        const response = await raw(index.name, 'DELETE');
        await response.body?.cancel();
      }
    }
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  const worker = (writer = bulk) =>
    createSearchIndexWorker({ prisma, bulk: writer, pollIntervalMs: 100, now: () => now });
  const advancePastLease = () => {
    now = new Date(now.getTime() + 31_000);
  };

  function pauseWrite(afterCommit = false) {
    const sampled = Promise.withResolvers<readonly SearchIndexWrite[]>();
    const release = Promise.withResolvers<void>();
    const flight = worker({
      async write(writes) {
        const committed = afterCommit ? await bulk.write(writes) : undefined;
        sampled.resolve(writes);
        await release.promise;
        return committed ?? bulk.write(writes);
      },
    }).runOnce();
    return {
      sampled: Promise.race([
        sampled.promise,
        flight.then(() => {
          throw new Error('Batch never reached the writer');
        }),
      ]),
      release,
      flight,
    };
  }

  it('completes a replay after the previous worker committed the same document and lost its lease', async () => {
    const { ticket } = await submitTicket(prisma, {
      requesterId: USERS.erin,
      title: 'Retry the same projection',
      description: 'A single indexed document survives both deliveries',
    });
    const old = pauseWrite(true);
    try {
      await old.sampled;
      const firstWrite = await raw(`${searchIndexes.tickets.name}/_doc/${ticket.id}`);
      expect(await firstWrite.json()).toMatchObject({ _version: 2 });
      advancePastLease();
      await worker().runOnce();
      expect(
        await prisma.searchIndexJob.findFirst({ where: { entityId: ticket.id } }),
      ).toMatchObject({
        state: 'COMPLETED',
        attempts: 2,
        errorKind: null,
      });
    } finally {
      old.release.resolve();
      await old.flight;
    }
    const stored = await raw(`${searchIndexes.tickets.name}/_doc/${ticket.id}`);
    expect(await stored.json()).toMatchObject({ _version: 2 });
    expect((await raw(`${searchIndexes.tickets.name}/_refresh`, 'POST')).ok).toBe(true);
    expect(
      await search.search('tickets', {
        query: { term: { id: ticket.id } },
        size: 25,
      }),
    ).toEqual([{ id: ticket.id }]);
  }, 20_000);

  it('reclaims a crashed attempt and prevents a stale publish from overwriting an unpublish tombstone', async () => {
    const knowledge = createKnowledgeService(prisma);
    const article = await knowledge.create({
      title: 'Published instructions',
      body: 'Searchable steps',
    });
    const id = article.id;
    await knowledge.setPublished(id, true);
    const old = pauseWrite();
    try {
      expect(await old.sampled).toMatchObject([
        { id, externalVersion: 4, document: { body: 'Searchable steps' } },
      ]);
      await knowledge.setPublished(id, false);
      advancePastLease();
      await worker().runOnce();
      expect(
        await prisma.searchIndexJob.findMany({
          where: { entityId: id },
          orderBy: { revision: 'asc' },
        }),
      ).toMatchObject([
        { revision: 2, state: 'COMPLETED', attempts: 2 },
        { revision: 3, state: 'COMPLETED', attempts: 1 },
      ]);
    } finally {
      old.release.resolve();
      await old.flight;
    }
    const tombstone = await raw(`${searchIndexes.knowledge.name}/_doc/${id}`);
    expect(await tombstone.json()).toMatchObject({
      _version: 7,
      _source: { articleId: id, isPublished: false, version: 3 },
    });
    const source = await raw(`${searchIndexes.knowledge.name}/_source/${id}`);
    expect(await source.json()).toEqual({ articleId: id, isPublished: false, version: 3 });
    expect((await raw(`${searchIndexes.knowledge.name}/_refresh`, 'POST')).ok).toBe(true);
    expect(await search.search('knowledge', find)).toEqual([]);

    await knowledge.setPublished(id, true);
    await worker().runOnce();
    expect((await raw(`${searchIndexes.knowledge.name}/_refresh`, 'POST')).ok).toBe(true);
    expect(await search.search('knowledge', find)).toEqual([{ id }]);
    const live = await raw(`${searchIndexes.knowledge.name}/_doc/${id}`);
    expect(await live.json()).toMatchObject({
      _version: 8,
      _source: { body: 'Searchable steps', version: 4 },
    });
  }, 20_000);

  it('hides a missing ticket even when a delayed write has the same source revision', async () => {
    const ticket = await withTransaction(prisma, async (tx) => {
      const row = await tx.ticket.create({
        data: { requesterId: USERS.erin, title: 'Synthetic ticket', description: 'Source text' },
      });
      await enqueueSearchIndexJob(tx, {
        entityType: 'TICKET',
        entityId: row.id,
        revision: row.version,
        eventKind: 'UPSERT',
      });
      return row;
    });
    const old = pauseWrite();
    try {
      expect(await old.sampled).toMatchObject([{ externalVersion: 2 }]);
      await prisma.ticket.delete({ where: { id: ticket.id } });
      advancePastLease();
      await worker().runOnce();
    } finally {
      old.release.resolve();
      await old.flight;
    }
    const removed = await raw(`${searchIndexes.tickets.name}/_doc/${ticket.id}`);
    expect(await removed.json()).toMatchObject({
      _version: 3,
      _source: { id: ticket.id, version: 1 },
    });
    const source = await raw(`${searchIndexes.tickets.name}/_source/${ticket.id}`);
    expect(await source.json()).toEqual({ id: ticket.id, version: 1 });
    expect((await raw(`${searchIndexes.tickets.name}/_refresh`, 'POST')).ok).toBe(true);
    expect(
      await search.search('tickets', { query: { term: { id: ticket.id } }, size: 25 }),
    ).toEqual([]);
  }, 20_000);

  it('runs the active worker entrypoint, indexes the allowed ticket fields, and exits on SIGTERM', async () => {
    const { ticket } = await submitTicket(prisma, {
      requesterId: USERS.erin,
      title: 'VPN setup',
      description: 'VPN unavailable',
    });
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl,
        OPENSEARCH_ENABLED: 'true',
        OPENSEARCH_URL: config.url,
        WORKER_POLL_INTERVAL_MS: '100',
        AI_PROVIDER: 'none',
      },
      stdio: 'ignore',
    });
    const exited = once(child, 'exit');
    try {
      await expect
        .poll(
          async () =>
            (await prisma.searchIndexJob.findFirst({ where: { entityId: ticket.id } }))?.state,
          { timeout: 20_000, interval: 150 },
        )
        .toBe('COMPLETED');
      const indexed = await raw(`${searchIndexes.tickets.name}/_source/${ticket.id}`);
      expect(await indexed.json()).toEqual({
        id: ticket.id,
        trackingId: ticket.id,
        requesterId: USERS.erin,
        title: 'VPN setup',
        description: 'VPN unavailable',
        teamId: null,
        assigneeId: null,
        categoryId: null,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
        version: 1,
        priority: 'UNSET',
        status: 'OPEN',
      });
    } finally {
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      expect(code === 0 || signal === 'SIGTERM').toBe(true);
    }
  }, 30_000);
});
