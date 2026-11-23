import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSearchIndexJob } from '../../src/db/repositories/searchIndexJobs.js';
import { ARTICLES, CATEGORIES, RECOMMENDATIONS, TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import {
  addComment,
  approveRouting,
  reviewRecommendation,
  submitTicket,
  transitionTicket,
} from '../../src/db/services/ticketService.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createKnowledgeService } from '../../src/modules/knowledge/service.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('transactional search outbox', () => {
  const prisma = createTestPrisma();
  const knowledge = createKnowledgeService(prisma);
  const input = { requesterId: USERS.erin, title: 'VPN outage', description: 'Unable to connect' };
  const jobs = (entityId: string) =>
    prisma.searchIndexJob.findMany({ where: { entityId }, orderBy: { revision: 'asc' } });
  const revisions = async (entityId: string) =>
    (await jobs(entityId)).map(({ revision, eventKind }) => [revision, eventKind]);

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('commits one job for concurrent idempotent submissions and deduplicates enqueue by revision', async () => {
    const submission = { ...input, idempotencyKey: 'search-outbox-retry' };
    const [first, second] = await Promise.all([
      submitTicket(prisma, submission),
      submitTicket(prisma, submission),
    ]);
    const { ticket } = first;
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(second.ticket.id).toBe(ticket.id);

    const duplicate = await withTransaction(prisma, (tx) =>
      enqueueSearchIndexJob(tx, {
        entityType: 'TICKET',
        entityId: ticket.id,
        revision: ticket.version,
        eventKind: 'UPSERT',
      }),
    );
    expect(duplicate).toBe(0);
    expect(await jobs(ticket.id)).toEqual([
      expect.objectContaining({
        entityType: 'TICKET',
        entityId: ticket.id,
        revision: ticket.version,
        eventKind: 'UPSERT',
        state: 'QUEUED',
        attempts: 0,
        availableAt: expect.any(Date),
        leaseToken: null,
        lockedUntil: null,
      }),
    ]);
  });

  it('rolls back the ticket and its queued job when a later write fails', async () => {
    await prisma.$executeRaw`
      ALTER TABLE ticket_events ADD CONSTRAINT test_outbox_created_event_failure
      CHECK (event_type <> 'CREATED') NOT VALID`;
    try {
      await expect(submitTicket(prisma, input)).rejects.toMatchObject({ code: 'CONSTRAINT' });
      expect(await prisma.ticket.count({ where: { title: input.title } })).toBe(0);
      expect(await prisma.searchIndexJob.count()).toBe(0);
    } finally {
      await prisma.$executeRaw`ALTER TABLE ticket_events DROP CONSTRAINT test_outbox_created_event_failure`;
    }
  });

  it('queues routing, category, assignment, and lifecycle changes at their ticket versions', async () => {
    const { ticket } = await submitTicket(prisma, input);
    const change = {
      ticketId: ticket.id,
      actorId: USERS.admin,
      categoryId: CATEGORIES.network,
      priority: 'HIGH' as const,
      teamId: TEAMS.network,
      assigneeId: USERS.tara,
    };
    const routed = await approveRouting(prisma, change);
    expect((await approveRouting(prisma, change)).version).toBe(routed.version);
    expect(await revisions(ticket.id)).toEqual([
      [1, 'UPSERT'],
      [2, 'UPSERT'],
    ]);

    await approveRouting(prisma, { ...change, categoryId: CATEGORIES.access });
    await approveRouting(prisma, {
      ticketId: ticket.id,
      actorId: USERS.admin,
      teamId: TEAMS.hardware,
      assigneeId: USERS.hana,
    });
    for (const to of ['IN_PROGRESS', 'RESOLVED', 'CLOSED', 'OPEN'] as const) {
      await transitionTicket(prisma, {
        ticketId: ticket.id,
        actorId: to === 'OPEN' ? USERS.erin : USERS.admin,
        to,
        ...(to === 'RESOLVED' && { resolutionSummary: 'Restored access' }),
      });
    }
    await addComment(prisma, { ticketId: ticket.id, authorId: USERS.admin, body: 'Public reply' });
    await addComment(prisma, {
      ticketId: ticket.id,
      authorId: USERS.admin,
      body: 'Private note',
      isInternal: true,
    });
    const current = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(current).toMatchObject({ status: 'OPEN', version: 8, assigneeId: USERS.hana });
    expect(await revisions(ticket.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => [i + 1, 'UPSERT']),
    );
  });

  it('queues the winning routing change when two requests use the same ticket version', async () => {
    const { ticket } = await submitTicket(prisma, input);
    const change = { ticketId: ticket.id, actorId: USERS.admin, expectedVersion: ticket.version };
    const results = await Promise.allSettled([
      approveRouting(prisma, { ...change, priority: 'HIGH' }),
      approveRouting(prisma, { ...change, priority: 'LOW' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results).toContainEqual(
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'VERSION_CONFLICT' }),
      }),
    );
    expect(await revisions(ticket.id)).toEqual([
      [1, 'UPSERT'],
      [2, 'UPSERT'],
    ]);
  });

  it('queues approved AI routing changes and skips recommendation-only decisions', async () => {
    const { ticket } = await reviewRecommendation(prisma, {
      recommendationId: RECOMMENDATIONS.printerPending,
      reviewerId: USERS.admin,
      decision: 'OVERRIDDEN',
      override: { categoryId: CATEGORIES.hardware, priority: 'HIGH', teamId: TEAMS.hardware },
    });
    const rejected = await reviewRecommendation(prisma, {
      recommendationId: RECOMMENDATIONS.vpnReanalysis,
      reviewerId: USERS.admin,
      decision: 'REJECTED',
    });
    expect(await revisions(ticket.id)).toEqual([[ticket.version, 'UPSERT']]);
    expect(await jobs(rejected.ticket.id)).toEqual([]);
  });

  it('orders article edits, publication and removal while ignoring draft and unchanged edits', async () => {
    const created = await knowledge.create({ title: 'Connect to Wi-Fi', body: 'Draft steps' });
    const { id } = created;
    await knowledge.update(id, { body: 'Revised draft steps', categoryId: CATEGORIES.network });
    expect(await jobs(id)).toEqual([]);

    await Promise.all([knowledge.setPublished(id, true), knowledge.setPublished(id, true)]);
    await knowledge.update(id, { title: ' Connect to Wi-Fi ', categoryId: CATEGORIES.network });
    expect(await revisions(id)).toEqual([[2, 'UPSERT']]);

    await Promise.all([
      knowledge.update(id, { body: 'Published steps' }),
      knowledge.update(id, { categoryId: CATEGORIES.access }),
    ]);
    expect(await prisma.knowledgeArticle.findUniqueOrThrow({ where: { id } })).toMatchObject({
      searchRevision: 4,
      body: 'Published steps',
      categoryId: CATEGORIES.access,
    });
    await knowledge.setPublished(id, false);
    await knowledge.setPublished(id, false);
    await knowledge.update(id, { title: 'Updated in draft' });
    await knowledge.setPublished(id, true);

    expect(await revisions(id)).toEqual([
      [2, 'UPSERT'],
      [3, 'UPSERT'],
      [4, 'UPSERT'],
      [5, 'DELETE'],
      [6, 'UPSERT'],
    ]);
    expect((await jobs(id)).every((job) => job.entityType === 'KNOWLEDGE_ARTICLE')).toBe(true);
  });

  it('preserves publication and revision when an outbox write fails for an existing article', async () => {
    const id = ARTICLES.vpn;
    const before = await prisma.knowledgeArticle.findUniqueOrThrow({ where: { id } });
    expect(before).toMatchObject({ searchRevision: 1, isPublished: true });
    await prisma.$executeRaw`
      ALTER TABLE search_index_jobs ADD CONSTRAINT test_outbox_remove_failure
      CHECK (event_kind <> 'DELETE') NOT VALID`;
    try {
      await expect(knowledge.setPublished(id, false)).rejects.toMatchObject({ code: 'CONSTRAINT' });
      expect(await prisma.knowledgeArticle.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect(await jobs(id)).toEqual([]);
    } finally {
      await prisma.$executeRaw`ALTER TABLE search_index_jobs DROP CONSTRAINT test_outbox_remove_failure`;
    }
    await knowledge.setPublished(id, false);
    expect(await revisions(id)).toEqual([[2, 'DELETE']]);
  });
});
