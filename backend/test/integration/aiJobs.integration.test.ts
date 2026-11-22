import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import {
  claimNext,
  enqueueAnalysis,
  findLatestForTicket,
} from '../../src/db/repositories/aiAnalysisJobs.js';
import { submitTicket } from '../../src/db/services/ticketService.js';
import { CATEGORIES, TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import type { AnalysisDraft } from '../../src/modules/ai/analysisService.js';
import { createJobRunner, type JobRunnerConfig } from '../../src/modules/ai/jobRunner.js';
import { ProviderError } from '../../src/modules/ai/provider.js';
import { createTestPrisma, expectViolation, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const ORIGIN = 'http://app.test';
// Pinned clocks must be after the rows' real `run_after` (set by the database clock on insert).
const T0 = new Date(Date.now() + 3_600_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

const draft: AnalysisDraft = {
  categoryId: CATEGORIES.hardware,
  teamId: TEAMS.hardware,
  priority: 'MEDIUM',
  troubleshooting: 'Do the thing.',
  confidence: null,
  citedArticleIds: [],
  modelVersion: 'fake:test',
  retrievedArticleIds: [],
};

const config: JobRunnerConfig = {
  concurrency: 2,
  pollIntervalMs: 20,
  backoffBaseMs: 1000,
  handlerTimeoutMs: 200,
  leaseMs: 60_000,
};

describe.skipIf(!testDatabaseUrl)('durable AI analysis queue (integration)', () => {
  const prisma = createTestPrisma();
  const jobsFor = (ticketId: string) =>
    prisma.aiAnalysisJob.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
  const newTicket = (extra: object = {}) =>
    submitTicket(prisma, {
      requesterId: USERS.erin,
      title: 'Cannot print',
      description: 'Printer is jammed',
      ...extra,
    });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  describe('enqueue', () => {
    it('queues a job in the same transaction as the ticket', async () => {
      const { ticket } = await newTicket({ enqueueAnalysis: { maxAttempts: 4 } });
      const [job] = await jobsFor(ticket.id);
      expect(job).toMatchObject({ state: 'QUEUED', attempts: 0, maxAttempts: 4 });
    });

    it('queues nothing when AI is not enabled, and nothing on an idempotent replay', async () => {
      const plain = await newTicket();
      expect(await jobsFor(plain.ticket.id)).toHaveLength(0);

      const opts = { idempotencyKey: 'key-for-replay-1', enqueueAnalysis: { maxAttempts: 3 } };
      const first = await newTicket(opts);
      const again = await newTicket(opts);
      expect(again.created).toBe(false);
      expect(await jobsFor(first.ticket.id)).toHaveLength(1);
    });

    it('leaves no job behind when the ticket transaction rolls back', async () => {
      await expect(
        submitTicket(prisma, {
          requesterId: '00000001-0000-4000-8000-0000000000ff', // unknown requester
          title: 't',
          description: 'd',
          enqueueAnalysis: { maxAttempts: 3 },
        }),
      ).rejects.toBeDefined();
      expect(await prisma.aiAnalysisJob.count()).toBe(0);
    });

    it('is idempotent on (ticket, request id)', async () => {
      const requestId = '00000002-0000-4000-8000-000000000001';
      const a = await enqueueAnalysis(prisma, { ticketId: TICKETS.printer, requestId });
      const b = await enqueueAnalysis(prisma, { ticketId: TICKETS.printer, requestId });
      expect(b.id).toBe(a.id);
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer }); // a new request
      expect(await jobsFor(TICKETS.printer)).toHaveLength(2);
    });

    it('enforces its invariants in the database', async () => {
      const job = await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      await expectViolation(
        prisma.$executeRaw`UPDATE ai_analysis_jobs SET state = 'DONE' WHERE job_id = ${job.id}::uuid`,
        'ck_ai_jobs_state',
      );
      await expectViolation(
        prisma.$executeRaw`UPDATE ai_analysis_jobs SET state = 'RUNNING' WHERE job_id = ${job.id}::uuid`,
        'ck_ai_jobs_lease',
      );
      await expectViolation(
        prisma.$executeRaw`UPDATE ai_analysis_jobs SET state = 'COMPLETED' WHERE job_id = ${job.id}::uuid`,
        'ck_ai_jobs_terminal',
      );
    });
  });

  describe('claiming', () => {
    it('hands each due job to exactly one of many concurrent claimers', async () => {
      for (let i = 0; i < 5; i++) await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      const claims = await Promise.all(
        Array.from({ length: 12 }, () => claimNext(prisma, { leaseMs: 60_000 })),
      );
      const got = claims.filter((c) => c !== null);
      expect(got).toHaveLength(5);
      expect(new Set(got.map((c) => c!.id)).size).toBe(5);
      expect(got.every((c) => c!.state === 'RUNNING' && c!.attempts === 1)).toBe(true);
    });

    it('does not claim jobs that are not yet due', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      expect(
        await claimNext(prisma, { leaseMs: 1000, now: new Date(Date.now() - 3_600_000) }),
      ).toBeNull();
      expect(await claimNext(prisma, { leaseMs: 1000, now: at(60_000) })).not.toBeNull();
    });

    it('re-claims an expired lease with a new token (worker restart/crash recovery)', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      const first = (await claimNext(prisma, { leaseMs: 1000, now: T0 }))!;
      expect(await claimNext(prisma, { leaseMs: 1000, now: at(500) })).toBeNull(); // still leased
      const second = (await claimNext(prisma, { leaseMs: 1000, now: at(2000) }))!;
      expect(second.id).toBe(first.id);
      expect(second.attempts).toBe(2);
      expect(second.leaseToken).not.toBe(first.leaseToken);
    });

    it('marks a job whose worker keeps dying as FAILED(worker_lost) instead of looping forever', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer, maxAttempts: 2 });
      await claimNext(prisma, { leaseMs: 1000, now: T0 });
      await claimNext(prisma, { leaseMs: 1000, now: at(2000) });
      expect(await claimNext(prisma, { leaseMs: 1000, now: at(4000) })).toBeNull();
      expect(await findLatestForTicket(prisma, TICKETS.printer)).toMatchObject({
        state: 'FAILED',
        errorKind: 'worker_lost',
        attempts: 2,
      });
    });
  });

  describe('runner', () => {
    const runner = (
      analyse: (id: string) => Promise<AnalysisDraft>,
      persisted: string[] = [],
      overrides: Partial<JobRunnerConfig> = {},
      now?: () => Date,
    ) =>
      createJobRunner({
        prisma,
        analysis: { analyse },
        config: { ...config, ...overrides },
        persist: async (_tx, { job }) => void persisted.push(job.id),
        ...(now ? { now } : {}),
      });

    it('completes a job and runs persistence exactly once, even if delivered twice', async () => {
      const job = await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      const persisted: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));

      // Worker A claims the job at T0 and gets stuck mid-analysis.
      const a = runner(
        async () => (await gate, draft),
        persisted,
        { leaseMs: 1000, handlerTimeoutMs: 30_000 },
        () => T0,
      );
      const inFlight = a.runOnce();
      await expect
        .poll(async () => (await findLatestForTicket(prisma, TICKETS.printer))?.state)
        .toBe('RUNNING');

      // A's lease expires, so worker B claims the same job and finishes it.
      const b = runner(
        async () => draft,
        persisted,
        {},
        () => at(5000),
      );
      expect(await b.runOnce()).toBe(true);

      release(); // A finally returns, holding a stale lease token
      await inFlight;

      expect(persisted).toEqual([job.id]);
      expect(await findLatestForTicket(prisma, TICKETS.printer)).toMatchObject({
        state: 'COMPLETED',
        attempts: 2,
        errorKind: null,
      });
    });

    it('retries transient failures with exponential backoff, then completes', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer, maxAttempts: 3 });
      let calls = 0;
      const persisted: string[] = [];
      const analyse = async () => {
        if (++calls < 3) throw new ProviderError('rate_limited');
        return draft;
      };

      let clock = T0;
      const r = runner(analyse, persisted, {}, () => clock);
      expect(await r.runOnce()).toBe(true);
      let job = (await findLatestForTicket(prisma, TICKETS.printer))!;
      expect(job).toMatchObject({ state: 'QUEUED', attempts: 1, errorKind: 'rate_limited' });
      expect(job.runAfter.getTime() - T0.getTime()).toBe(1000); // base * 2^0

      expect(await r.runOnce()).toBe(false); // backoff not elapsed
      clock = at(1000);
      await r.runOnce();
      job = (await findLatestForTicket(prisma, TICKETS.printer))!;
      expect(job.runAfter.getTime() - clock.getTime()).toBe(2000); // base * 2^1

      clock = at(10_000);
      await r.runOnce();
      expect(await findLatestForTicket(prisma, TICKETS.printer)).toMatchObject({
        state: 'COMPLETED',
        attempts: 3,
      });
      expect(persisted).toHaveLength(1);
    });

    it('fails terminally with a reason code after the retries are exhausted', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer, maxAttempts: 2 });
      const persisted: string[] = [];
      let clock = T0;
      const r = runner(
        async () => {
          throw new ProviderError('unavailable');
        },
        persisted,
        {},
        () => clock,
      );
      await r.runOnce();
      clock = at(60_000);
      await r.runOnce();
      clock = at(120_000);
      expect(await r.runOnce()).toBe(false);
      expect(await findLatestForTicket(prisma, TICKETS.printer)).toMatchObject({
        state: 'FAILED',
        attempts: 2,
        errorKind: 'unavailable',
      });
      expect(persisted).toEqual([]);
    });

    it('does not retry non-retryable failures and never stores error text', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer, maxAttempts: 5 });
      await runner(async () => {
        throw new ProviderError('malformed', 'secret sk-abc leaked in message');
      }).runOnce();
      const job = (await findLatestForTicket(prisma, TICKETS.printer))!;
      expect(job).toMatchObject({ state: 'FAILED', attempts: 1, errorKind: 'malformed' });
      expect(JSON.stringify(job)).not.toContain('sk-abc');
    });

    it('treats an unexpected exception as a retryable internal error', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      await runner(async () => {
        throw new Error('boom: password=hunter2');
      }).runOnce();
      const job = (await findLatestForTicket(prisma, TICKETS.printer))!;
      expect(job).toMatchObject({ state: 'QUEUED', errorKind: 'internal' });
    });

    it('times out a hung provider as a retryable timeout', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      await runner(() => new Promise(() => {}), [], { handlerTimeoutMs: 50 }).runOnce();
      expect(await findLatestForTicket(prisma, TICKETS.printer)).toMatchObject({
        state: 'QUEUED',
        errorKind: 'timeout',
      });
    });

    it('rolls the job back to a retry when persistence throws', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      const r = createJobRunner({
        prisma,
        analysis: { analyse: async () => draft },
        config,
        persist: async () => {
          throw new Error('db hiccup');
        },
      });
      await r.runOnce();
      expect(await findLatestForTicket(prisma, TICKETS.printer)).toMatchObject({
        state: 'QUEUED',
        errorKind: 'internal',
        attempts: 1,
      });
    });

    it('survives a worker restart: queued work is picked up by a new runner', async () => {
      const { ticket } = await newTicket({ enqueueAnalysis: { maxAttempts: 3 } });
      // "Worker down": the ticket and job exist, nothing processes them.
      expect((await jobsFor(ticket.id))[0]!.state).toBe('QUEUED');

      const persisted: string[] = [];
      const started = runner(async () => draft, persisted);
      started.start();
      await expect
        .poll(async () => (await findLatestForTicket(prisma, ticket.id))?.state, { timeout: 5000 })
        .toBe('COMPLETED');
      await started.stop();
      expect(persisted).toHaveLength(1);
    });

    it('stop() waits for in-flight work and then claims nothing more', async () => {
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      let finished = false;
      const r = runner(async () => {
        await new Promise((res) => setTimeout(res, 100));
        finished = true;
        return draft;
      });
      r.start();
      await expect
        .poll(async () => (await findLatestForTicket(prisma, TICKETS.printer))?.state)
        .toBe('RUNNING');
      await r.stop();
      expect(finished).toBe(true);
      expect(await findLatestForTicket(prisma, TICKETS.printer)).toMatchObject({
        state: 'COMPLETED',
      });
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
      await new Promise((res) => setTimeout(res, 100));
      expect((await jobsFor(TICKETS.printer)).filter((j) => j.state === 'QUEUED')).toHaveLength(1);
    });
  });

  describe('ticket submission API', () => {
    const tokens = new TokenService(loadEnv({}));
    const post = async (app: FastifyInstance) => {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: USERS.erin } });
      const token = await tokens.sign('access', USERS.erin, u.tokenVersion);
      const started = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'VPN down', description: 'Cannot connect' },
      });
      return { res, ms: Date.now() - started };
    };
    const appFor = (env: ReturnType<typeof loadEnv>) =>
      buildApp({
        env,
        prisma,
        checkDb: async () => true,
        checkCache: async () => 'disabled' as const,
        logger: false,
        authRateLimit: { login: 10_000, refresh: 10_000, windowMs: 60_000 },
      });

    it('returns 201 promptly and queues a job, with no worker and a hanging provider', async () => {
      // A provider that would hang forever is irrelevant: nothing in the request path calls it.
      const env = loadEnv({ FRONTEND_ORIGIN: ORIGIN, AI_PROVIDER: 'fake' });
      const app = await appFor(env);
      try {
        const { res, ms } = await post(app);
        expect(res.statusCode).toBe(201);
        expect(ms).toBeLessThan(2000);
        const id = res.json().data.id as string;
        expect(await jobsFor(id)).toMatchObject([{ state: 'QUEUED', maxAttempts: 3 }]);
      } finally {
        await app.close();
      }
    });

    it('queues nothing when AI_PROVIDER=none', async () => {
      const app = await appFor(loadEnv({ FRONTEND_ORIGIN: ORIGIN }));
      try {
        const { res } = await post(app);
        expect(res.statusCode).toBe(201);
        expect(await prisma.aiAnalysisJob.count()).toBe(0);
      } finally {
        await app.close();
      }
    });
  });
});
