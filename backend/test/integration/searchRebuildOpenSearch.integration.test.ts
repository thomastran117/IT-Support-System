import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadActivePrincipal } from '../../src/auth/guard.js';
import {
  claimSearchIndexJobs,
  enqueueSearchIndexJob,
} from '../../src/db/repositories/searchIndexJobs.js';
import { ARTICLES, CATEGORIES, TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { approveRouting, submitTicket } from '../../src/db/services/ticketService.js';
import { createKnowledgeService } from '../../src/modules/knowledge/service.js';
import { createSearchBulkClient, type SearchBulkClient } from '../../src/modules/search/bulk.js';
import { createSearchClient } from '../../src/modules/search/client.js';
import { searchGeneration } from '../../src/modules/search/indexes.js';
import { createSearchRebuild } from '../../src/modules/search/rebuild.js';
import {
  createSearchRebuildAdmin,
  type SearchRebuildAdmin,
} from '../../src/modules/search/rebuildAdmin.js';
import { createTicketSearchService } from '../../src/modules/search/ticketSearch.js';
import { SearchError } from '../../src/modules/search/transport.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const testUrl = process.env.TEST_OPENSEARCH_URL;
const seededId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!testDatabaseUrl || !testUrl)('resumable search rebuild against OpenSearch', () => {
  const prisma = createTestPrisma();
  const config = { enabled: true, url: testUrl ?? 'http://search.invalid/' } as const;
  const admin = createSearchRebuildAdmin(config);
  const search = createSearchClient(config, { timeoutMs: 3_000 })!;
  const knowledge = createKnowledgeService(prisma);
  const targets = [1, 2].flatMap((version) => Object.values(searchGeneration(version)));
  let ownsTargets = false;
  const raw = (path: string, method = 'GET') =>
    fetch(new URL(path, config.url), {
      method,
      signal: AbortSignal.timeout(5_000),
    });
  const source = async (index: string, id: string) => {
    const response = await raw(`${index}/_source/${id}`);
    expect(response.ok).toBe(true);
    return response.json();
  };
  const rebuild = (
    version: number,
    overrides: { admin?: SearchRebuildAdmin; bulk?: SearchBulkClient } = {},
  ) =>
    createSearchRebuild({
      prisma,
      admin,
      bulk: createSearchBulkClient(config, { targets: searchGeneration(version) })!,
      version,
      ...overrides,
    });

  beforeAll(async () => {
    expect(await admin.activeVersion()).toBeNull();
    for (const target of targets) expect((await raw(target, 'HEAD')).status).toBe(404);
    ownsTargets = true;
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    await prisma.ticket.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        id: seededId(i + 100),
        requesterId: USERS.erin,
        title: 'Unindexed ticket',
        description: 'Backfill fixture',
      })),
    });
  });
  afterEach(async () => {
    if (ownsTargets) {
      for (const target of targets) {
        const response = await raw(target, 'DELETE');
        await response.body?.cancel();
      }
    }
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('previews without writes, resumes keyset scanning, and backfills seeded live documents once', async () => {
    const bootstrap = rebuild(1);
    const plan = await bootstrap.plan();
    expect(plan).toMatchObject({ activeVersion: null, phase: 'NEW' });
    expect(await prisma.searchRebuild.count()).toBe(0);
    for (const target of targets) expect((await raw(target, 'HEAD')).status).toBe(404);

    await bootstrap.step();
    await bootstrap.step();
    const checkpoint = await bootstrap.step();
    expect(checkpoint).toMatchObject({ phase: 'TICKETS', scanCursor: seededId(124) });
    const stop = new AbortController();
    stop.abort();
    await expect(bootstrap.run(stop.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await admin.activeVersion()).toBeNull();
    expect(await prisma.searchRebuild.findUnique({ where: { version: 1 } })).toEqual(checkpoint);

    const completed = await rebuild(1).run();
    expect(completed).toMatchObject({
      phase: 'COMPLETED',
      verifiedTickets: plan.tickets,
      verifiedArticles: plan.articles,
    });
    expect(await admin.activeVersion()).toBe(1);
    expect(
      await search.search('tickets', { query: { term: { id: seededId(100) } }, size: 10 }),
    ).toEqual([{ id: seededId(100) }]);
    expect(
      await search.search('knowledge', { query: { term: { articleId: ARTICLES.vpn } }, size: 10 }),
    ).toEqual([{ id: ARTICLES.vpn }]);
    expect(
      (await raw(`${searchGeneration(1).knowledge}/_doc/${ARTICLES.draft}`, 'HEAD')).status,
    ).toBe(404);
    expect(await rebuild(1).run()).toEqual(completed);
    expect(await admin.liveCounts(1)).toEqual({ tickets: plan.tickets, articles: plan.articles });

    const tickets = createTicketSearchService(prisma, search);
    const { principal } = (await loadActivePrincipal(prisma, USERS.erin))!;
    const page = await tickets.search(principal, { text: 'Unindexed', limit: 2 });
    expect(page.items.map(({ id }) => id)).toEqual([seededId(100), seededId(101)]);
    expect(page.nextCursor).not.toBeNull();
    const next = await tickets.search(principal, {
      text: 'Unindexed',
      limit: 2,
      after: page.nextCursor!,
    });
    expect(next.items.map(({ id }) => id)).toEqual([seededId(102), seededId(103)]);

    const { principal: technician } = (await loadActivePrincipal(prisma, USERS.tara))!;
    const routed = await tickets.search(technician, {
      filters: { teamId: TEAMS.network },
      limit: 10,
    });
    expect(new Set(routed.items.map(({ id }) => id))).toEqual(
      new Set([TICKETS.vpn, TICKETS.license, TICKETS.password, TICKETS.reopened]),
    );
    const backlog = await tickets.search(technician, { text: 'Unindexed', limit: 2 });
    expect(backlog.items.map(({ id }) => id)).toEqual([seededId(100), seededId(101)]);
    expect(
      await tickets.search(technician, { filters: { teamId: TEAMS.hardware }, limit: 10 }),
    ).toEqual({
      items: [],
      nextCursor: null,
    });
  }, 45_000);

  it('preserves live aliases on verification failure and replays changes behind the scan cursor', async () => {
    await rebuild(1).run();
    const replacement = rebuild(2);
    await replacement.step();
    await replacement.step();
    expect(await replacement.step()).toMatchObject({ phase: 'TICKETS', scanCursor: seededId(124) });
    await approveRouting(prisma, {
      ticketId: seededId(100),
      actorId: USERS.admin,
      priority: 'HIGH',
      categoryId: CATEGORIES.network,
      teamId: TEAMS.network,
    });
    await prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.create({
        data: {
          id: seededId(1),
          requesterId: USERS.erin,
          title: 'Created behind cursor',
          description: 'Committed during the scan',
        },
      });
      await enqueueSearchIndexJob(tx, {
        entityType: 'TICKET',
        entityId: ticket.id,
        revision: ticket.version,
        eventKind: 'UPSERT',
      });
    });
    expect(await replacement.step()).toMatchObject({ phase: 'KNOWLEDGE' });
    expect(await replacement.step()).toMatchObject({ phase: 'REPLAY', replayUntil: 2n });
    await knowledge.setPublished(ARTICLES.vpn, false);

    const mismatched = rebuild(2, {
      admin: {
        ...admin,
        async liveCounts(version) {
          const counts = await admin.liveCounts(version);
          return { ...counts, tickets: counts.tickets - 1 };
        },
      },
    });
    await expect(mismatched.run()).rejects.toThrow(/counts differ/);
    expect(await admin.activeVersion()).toBe(1);
    expect(await prisma.searchRebuild.findUnique({ where: { version: 2 } })).toMatchObject({
      phase: 'REPLAY',
      replayedThrough: 2n,
    });

    const completed = await rebuild(2).run();
    expect(completed).toMatchObject({ phase: 'COMPLETED', sourceVersion: 1, replayedThrough: 3n });
    expect(await admin.activeVersion()).toBe(2);
    expect(await source(searchGeneration(1).tickets, seededId(100))).toMatchObject({
      status: 'OPEN',
      version: 1,
    });
    expect(await source(searchGeneration(2).tickets, seededId(100))).toMatchObject({
      status: 'TRIAGED',
      version: 2,
    });
    expect(await source(searchGeneration(2).tickets, seededId(1))).toMatchObject({
      title: 'Created behind cursor',
    });
    expect(await source(searchGeneration(2).knowledge, ARTICLES.vpn)).toEqual({
      articleId: ARTICLES.vpn,
      isPublished: false,
      version: 2,
    });
    expect(
      await search.search('knowledge', { query: { term: { articleId: ARTICLES.vpn } }, size: 10 }),
    ).toEqual([]);
    expect((await raw(searchGeneration(1).knowledge, 'HEAD')).status).toBe(200);
  }, 60_000);

  it('pauses claims across an ambiguous alias response and catches up before resuming', async () => {
    await rebuild(1).run();
    const uncertain = rebuild(2, {
      admin: {
        ...admin,
        async swap(previous, version) {
          await admin.swap(previous, version);
          throw new SearchError('timeout');
        },
      },
    });
    await expect(uncertain.run()).rejects.toMatchObject({ code: 'timeout' });
    expect(await admin.activeVersion()).toBe(2);
    expect(await prisma.searchRebuild.findUnique({ where: { version: 2 } })).toMatchObject({
      phase: 'CUTOVER',
    });
    const { ticket } = await submitTicket(prisma, {
      requesterId: USERS.erin,
      title: 'After alias timeout',
      description: 'Queues during cutover',
    });
    for (let edit = 1; edit <= 26; edit++) {
      await knowledge.update(ARTICLES.vpn, { body: `Edit ${edit} while claims were paused` });
    }
    const claim = () => claimSearchIndexJobs(prisma, { limit: 30, leaseMs: 30_000 });
    expect(await claim()).toEqual([]);

    const resumed = rebuild(2);
    expect(await resumed.step()).toMatchObject({
      phase: 'CUTOVER',
      replayUntil: 27n,
      replayedThrough: 0n,
    });
    expect(await claim()).toEqual([]);
    const state = await resumed.run();
    expect(state).toMatchObject({ phase: 'COMPLETED', replayedThrough: 27n });
    expect(await source(searchGeneration(2).tickets, ticket.id)).toMatchObject({
      title: 'After alias timeout',
    });
    expect(await source(searchGeneration(2).knowledge, ARTICLES.vpn)).toMatchObject({
      body: 'Edit 26 while claims were paused',
    });
    const claimed = await claim();
    expect(claimed).toHaveLength(27);
    expect([...new Set(claimed.map((job) => job.entityId))].sort()).toEqual(
      [ticket.id, ARTICLES.vpn].sort(),
    );
  }, 60_000);
});
