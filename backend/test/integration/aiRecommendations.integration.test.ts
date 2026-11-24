import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueAnalysis, findLatestForTicket } from '../../src/db/repositories/aiAnalysisJobs.js';
import { hashCorrelationId } from '../../src/db/repositories/serviceEvents.js';
import { reviewRecommendation } from '../../src/db/services/ticketService.js';
import { withTransaction } from '../../src/db/transaction.js';
import { ARTICLES, CATEGORIES, TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import type { AnalysisDraft } from '../../src/modules/ai/analysisService.js';
import { createJobRunner } from '../../src/modules/ai/jobRunner.js';
import { ProviderError } from '@smartdesk/ai-analysis';
import { persistDraft, persistRecommendation } from '../../src/modules/ai/recommendationService.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const UNKNOWN = '00000001-0000-4000-8000-0000000000ee';

const draftOf = (over: Partial<AnalysisDraft> = {}): AnalysisDraft => ({
  categoryId: CATEGORIES.hardware,
  teamId: TEAMS.hardware,
  priority: 'HIGH',
  troubleshooting: 'Clear the jam and restart the print spooler.',
  confidence: 0.8125,
  citedArticleIds: [ARTICLES.printer, ARTICLES.software, ARTICLES.vpn],
  modelVersion: 'fake:test',
  retrievedArticleIds: [ARTICLES.printer, ARTICLES.software, ARTICLES.vpn],
  retrieval: { engine: 'postgres', version: 1 },
  ...over,
});

describe.skipIf(!testDatabaseUrl)('recommendation persistence (integration)', () => {
  const prisma = createTestPrisma();

  const newJob = (ticketId: string = TICKETS.printer) => enqueueAnalysis(prisma, { ticketId });
  const persist = (job: { id: string; ticketId: string }, draft = draftOf()) =>
    withTransaction(prisma, (tx) => persistRecommendation(tx, { job, draft }));
  const counts = async () => ({
    recs: await prisma.aiRecommendation.count(),
    links: await prisma.recommendationArticle.count(),
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('stores one PENDING recommendation with ranked, accurate source links', async () => {
    const before = await counts();
    const job = await newJob();
    const { recommendationId, created } = await persist(job);
    expect(created).toBe(true);

    const rec = await prisma.aiRecommendation.findUniqueOrThrow({
      where: { id: recommendationId },
      include: { articles: { orderBy: { relevanceRank: 'asc' } } },
    });
    expect(rec).toMatchObject({
      jobId: job.id,
      ticketId: TICKETS.printer,
      proposedCategoryId: CATEGORIES.hardware,
      proposedTeamId: TEAMS.hardware,
      proposedPriority: 'HIGH',
      suggestion: 'Clear the jam and restart the print spooler.',
      modelVersion: 'fake:test@prompt-v2',
      reviewStatus: 'PENDING',
      reviewerId: null,
      reviewedAt: null,
    });
    expect(Number(rec.confidence)).toBe(0.813); // NUMERIC(4,3)
    expect(rec.articles.map((a) => [a.articleId, a.relevanceRank])).toEqual([
      [ARTICLES.printer, 1],
      [ARTICLES.software, 2],
      [ARTICLES.vpn, 3],
    ]);
    expect(await counts()).toEqual({ recs: before.recs + 1, links: before.links + 3 });
    expect(
      await prisma.serviceOutboxEvent.findUnique({ where: { eventId: recommendationId } }),
    ).toMatchObject({
      type: 'recommendation.ready',
      aggregateId: job.ticketId,
      correlationId: job.requestId,
      payload: { recommendationId, jobId: job.id, requestId: job.requestId },
    });
  });

  it('publishes one recommendation-ready event with the originating request correlation', async () => {
    const correlationId = 'request header from gateway';
    const job = await enqueueAnalysis(prisma, { ticketId: TICKETS.printer, correlationId });
    const { recommendationId } = await persist(job);
    expect(await persist(job)).toEqual({ recommendationId, created: false });
    const events = await prisma.serviceOutboxEvent.findMany({
      where: { type: 'recommendation.ready' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: recommendationId,
      schemaVersion: 1,
      correlationId: hashCorrelationId(correlationId),
      payload: { recommendationId, jobId: job.id, requestId: job.requestId },
    });
  });

  it('accepts a recommendation with no confidence and no sources', async () => {
    const job = await newJob();
    const { recommendationId } = await persist(
      job,
      draftOf({ confidence: null, citedArticleIds: [] }),
    );
    const rec = await prisma.aiRecommendation.findUniqueOrThrow({
      where: { id: recommendationId },
    });
    expect(rec.confidence).toBeNull();
    expect(await prisma.recommendationArticle.count({ where: { recommendationId } })).toBe(0);
  });

  it('does not touch the ticket', async () => {
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } });
    await persist(await newJob());
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } })).toEqual(
      before,
    );
  });

  describe('retries and duplicates', () => {
    it('yields exactly one recommendation and one set of links per job', async () => {
      const job = await newJob();
      const first = await persist(job);
      const again = await persist(job, draftOf({ priority: 'LOW', citedArticleIds: [] }));
      expect(again).toEqual({ recommendationId: first.recommendationId, created: false });
      const rows = await prisma.aiRecommendation.findMany({ where: { jobId: job.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.proposedPriority).toBe('HIGH'); // the repeat did not overwrite it
      expect(
        await prisma.recommendationArticle.count({ where: { recommendationId: rows[0]!.id } }),
      ).toBe(3);
    });

    it('is unique per job in the database itself', async () => {
      const job = await newJob();
      await persist(job);
      await expect(
        prisma.$executeRaw`INSERT INTO ai_recommendations (ticket_id, job_id, model_version)
          VALUES (${TICKETS.printer}::uuid, ${job.id}::uuid, 'dup')`,
      ).rejects.toBeDefined();
    });

    it('through the runner: a transient failure then success persists once', async () => {
      const job = await newJob();
      let calls = 0;
      let clock = new Date(Date.now() + 3_600_000);
      const runner = createJobRunner({
        prisma,
        analysis: {
          analyse: async () => {
            if (++calls === 1) throw new ProviderError('timeout');
            return draftOf();
          },
        },
        persist: persistDraft,
        now: () => clock,
        config: {
          concurrency: 1,
          pollIntervalMs: 20,
          backoffBaseMs: 1000,
          handlerTimeoutMs: 5000,
          leaseMs: 60_000,
        },
      });
      await runner.runOnce();
      expect(await prisma.aiRecommendation.count({ where: { jobId: job.id } })).toBe(0);
      clock = new Date(clock.getTime() + 10_000);
      await runner.runOnce();
      expect(await findLatestForTicket(prisma, TICKETS.printer)).toMatchObject({
        state: 'COMPLETED',
        attempts: 2,
      });
      expect(await prisma.aiRecommendation.count({ where: { jobId: job.id } })).toBe(1);
    });

    it('through the runner: duplicate delivery to a stale worker adds nothing', async () => {
      const job = await newJob();
      const t0 = new Date(Date.now() + 3_600_000);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const mk = (analyse: () => Promise<AnalysisDraft>, now: Date) =>
        createJobRunner({
          prisma,
          analysis: { analyse },
          persist: persistDraft,
          now: () => now,
          config: {
            concurrency: 1,
            pollIntervalMs: 20,
            backoffBaseMs: 1000,
            handlerTimeoutMs: 30_000,
            leaseMs: 1000,
          },
        });
      const stale = mk(async () => (await gate, draftOf()), t0).runOnce();
      await expect
        .poll(async () => (await findLatestForTicket(prisma, TICKETS.printer))?.state)
        .toBe('RUNNING');
      await mk(async () => draftOf(), new Date(t0.getTime() + 5000)).runOnce();
      release();
      await stale;
      expect(await prisma.aiRecommendation.count({ where: { jobId: job.id } })).toBe(1);
      expect(await prisma.recommendationArticle.count()).toBe(
        3 +
          (await prisma.recommendationArticle.count({
            where: { recommendation: { jobId: null } },
          })),
      );
    });
  });

  describe('atomicity and validation', () => {
    it.each([
      ['unknown article', { citedArticleIds: [ARTICLES.printer, UNKNOWN] }],
      ['unpublished article', { citedArticleIds: [ARTICLES.printer, ARTICLES.draft] }],
      ['repeated article', { citedArticleIds: [ARTICLES.printer, ARTICLES.printer] }],
      ['unknown category', { categoryId: UNKNOWN }],
      ['inactive category', { categoryId: CATEGORIES.legacy }],
      ['inactive team', { teamId: TEAMS.legacy }],
      ['UNSET priority', { priority: 'UNSET' as never }],
      ['confidence above 1', { confidence: 1.2 }],
      ['NaN confidence', { confidence: Number.NaN }],
      ['blank model version', { modelVersion: '  ' }],
      ['oversized model version', { modelVersion: 'x'.repeat(120) }],
      ['empty troubleshooting', { troubleshooting: '   ' }],
    ])('rejects %s and writes nothing', async (_name, patch) => {
      const job = await newJob();
      const before = await counts();
      await expect(persist(job, draftOf(patch))).rejects.toBeDefined();
      expect(await counts()).toEqual(before);
    });

    it('rolls back the whole graph when anything later in the transaction fails', async () => {
      const job = await newJob();
      const before = await counts();
      await expect(
        withTransaction(prisma, async (tx) => {
          await persistRecommendation(tx, { job, draft: draftOf() });
          throw new Error('simulated database failure after the writes');
        }),
      ).rejects.toBeDefined();
      expect(await counts()).toEqual(before);
      // The job is still free to produce its recommendation on the next attempt.
      expect((await persist(job)).created).toBe(true);
    });
  });

  describe('multiple analyses and review', () => {
    it('keeps every attempt as its own row, oldest first', async () => {
      const a = await persist(await newJob());
      const b = await persist(await newJob(), draftOf({ priority: 'LOW', citedArticleIds: [] }));
      expect(a.recommendationId).not.toBe(b.recommendationId);
      const rows = await prisma.aiRecommendation.findMany({
        where: { ticketId: TICKETS.printer, jobId: { not: null } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(rows.map((r) => r.id)).toEqual([a.recommendationId, b.recommendationId]);
      expect(rows.map((r) => r.proposedPriority)).toEqual(['HIGH', 'LOW']);
    });

    /** Every column that makes up the original proposal, plus its source links. */
    const snapshot = async (id: string) => {
      const r = await prisma.aiRecommendation.findUniqueOrThrow({
        where: { id },
        include: { articles: true },
      });
      return {
        jobId: r.jobId,
        ticketId: r.ticketId,
        proposedCategoryId: r.proposedCategoryId,
        proposedTeamId: r.proposedTeamId,
        proposedPriority: r.proposedPriority,
        suggestion: r.suggestion,
        confidence: r.confidence?.toString() ?? null,
        modelVersion: r.modelVersion,
        createdAt: r.createdAt,
        articles: r.articles,
      };
    };

    it.each([
      ['ACCEPTED', undefined],
      ['OVERRIDDEN', { categoryId: CATEGORIES.software, priority: 'LOW' as const }],
      ['REJECTED', undefined],
    ] as const)('leaves the proposal unchanged after %s', async (decision, override) => {
      const { recommendationId } = await persist(await newJob());
      const proposal = await snapshot(recommendationId);

      await reviewRecommendation(prisma, {
        recommendationId,
        reviewerId: USERS.admin,
        decision,
        ...(override ? { override } : {}),
      });

      const after = await prisma.aiRecommendation.findUniqueOrThrow({
        where: { id: recommendationId },
      });
      expect(after.reviewStatus).toBe(decision);
      expect(await snapshot(recommendationId)).toEqual(proposal);
    });

    it('a later analysis does not disturb an already reviewed one', async () => {
      const first = await persist(await newJob());
      await reviewRecommendation(prisma, {
        recommendationId: first.recommendationId,
        reviewerId: USERS.admin,
        decision: 'ACCEPTED',
      });
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } });
      const second = await persist(await newJob(), draftOf({ priority: 'CRITICAL' }));

      expect(
        await prisma.aiRecommendation.findUniqueOrThrow({ where: { id: first.recommendationId } }),
      ).toMatchObject({ reviewStatus: 'ACCEPTED', proposedPriority: 'HIGH' });
      expect(
        await prisma.aiRecommendation.findUniqueOrThrow({ where: { id: second.recommendationId } }),
      ).toMatchObject({ reviewStatus: 'PENDING', proposedPriority: 'CRITICAL' });
      // Approved routing came from the accepted proposal only.
      expect(ticket.priority).toBe('HIGH');
      expect(
        await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } }),
      ).toMatchObject({ priority: 'HIGH', categoryId: CATEGORIES.hardware });
    });
  });
});
