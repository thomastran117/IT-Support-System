import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { claimNext, enqueueAnalysis } from '../../src/db/repositories/aiAnalysisJobs.js';
import { CATEGORIES, TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createAnalysisService } from '../../src/modules/ai/analysisService.js';
import { createJobRunner, type JobLogEntry } from '../../src/modules/ai/jobRunner.js';
import { ProviderError, type AIProvider } from '../../src/modules/ai/provider.js';
import { createFakeProvider } from '../../src/modules/ai/providers/fake.js';
import { persistDraft } from '../../src/modules/ai/recommendationService.js';
import { manualRiskCue } from '../../src/modules/ai/riskCue.js';
import { ANALYSES_PER_TICKET_PER_HOUR } from '../../src/modules/tickets/analysis.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const ORIGIN = 'http://app.test';
const SECRET = 'sk-live-TOPSECRETKEY1234567890';

interface Body {
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details: any;
}

describe.skipIf(!testDatabaseUrl)('AI failure handling and manual fallback (integration)', () => {
  const prisma = createTestPrisma();
  const apps: FastifyInstance[] = [];

  const makeApp = async (aiProvider: 'none' | 'fake') => {
    const env = loadEnv({ FRONTEND_ORIGIN: ORIGIN, AI_PROVIDER: aiProvider });
    const tokens = new TokenService(env);
    const app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      logger: false,
      authRateLimit: { login: 10_000, refresh: 10_000, windowMs: 60_000 },
    });
    apps.push(app);
    const call = async (
      as: string,
      method: 'GET' | 'POST',
      url: string,
      payload?: unknown,
    ): Promise<{ status: number; body: Body }> => {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: as } });
      const token = await tokens.sign('access', as, u.tokenVersion);
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return { status: res.statusCode, body: res.json() as Body };
    };
    return { call };
  };

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  const runner = (provider: AIProvider, logs: JobLogEntry[] = [], clock?: () => Date) =>
    createJobRunner({
      prisma,
      analysis: createAnalysisService({ prisma, provider }),
      persist: persistDraft,
      log: (e) => logs.push(e),
      ...(clock ? { now: clock } : {}),
      config: {
        concurrency: 1,
        pollIntervalMs: 20,
        backoffBaseMs: 1000,
        handlerTimeoutMs: 5000,
        leaseMs: 60_000,
      },
    });

  describe('AI disabled (AI_PROVIDER=none): the whole manual workflow still works', () => {
    it('employee submits, technician triages and resolves, AI endpoints say so plainly', async () => {
      const { call } = await makeApp('none');

      const created = await call(USERS.erin, 'POST', '/api/tickets', {
        title: 'Printer on floor 3 is jammed',
        description: 'Paper is stuck in the tray.',
      });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;
      expect(await prisma.aiAnalysisJob.count({ where: { ticketId: id } })).toBe(0);

      const status = await call(USERS.tom, 'GET', `/api/tickets/${id}/analysis`);
      expect(status.status).toBe(200);
      expect(status.body.data).toMatchObject({
        enabled: false,
        state: 'NONE',
        failure: null,
        canRetry: false,
      });
      const ask = await call(USERS.tom, 'POST', `/api/tickets/${id}/analysis`);
      expect(ask.status).toBe(409);
      expect(ask.body.details.code).toBe('AI_DISABLED');
      expect(await prisma.aiAnalysisJob.count()).toBe(0);

      // Technician triage by hand: route, start work, resolve.
      const routed = await call(USERS.tom, 'POST', `/api/tickets/${id}/routing`, {
        categoryId: CATEGORIES.hardware,
        priority: 'MEDIUM',
        teamId: TEAMS.hardware,
        assigneeId: USERS.tom,
        expectedVersion: created.body.data.version,
      });
      expect(routed.status).toBe(200);
      let version = routed.body.data.version as number;
      if (routed.body.data.status === 'OPEN') {
        const t = await call(USERS.tom, 'POST', `/api/tickets/${id}/transitions`, {
          to: 'TRIAGED',
          expectedVersion: version,
        });
        expect(t.status).toBe(200);
        version = t.body.data.version;
      }
      const started = await call(USERS.tom, 'POST', `/api/tickets/${id}/transitions`, {
        to: 'IN_PROGRESS',
        expectedVersion: version,
      });
      expect(started.status).toBe(200);
      const resolved = await call(USERS.tom, 'POST', `/api/tickets/${id}/transitions`, {
        to: 'RESOLVED',
        expectedVersion: started.body.data.version,
        resolutionSummary: 'Cleared the jam and restarted the spooler.',
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body.data.status).toBe('RESOLVED');
      expect(await prisma.aiRecommendation.count({ where: { ticketId: id } })).toBe(0);
    });
  });

  describe('provider failures', () => {
    const failing = (kind: ConstructorParameters<typeof ProviderError>[0], message?: string) =>
      createFakeProvider(() => new ProviderError(kind, message));

    it.each([
      ['unavailable', 'provider_unavailable', true],
      ['timeout', 'timed_out', true],
      ['rate_limited', 'rate_limited', true],
      ['malformed', 'invalid_response', false],
      ['invalid_reference', 'invalid_response', false],
    ] as const)(
      '%s is surfaced as %s with no phantom recommendation and the ticket left OPEN',
      async (kind, reason, retryable) => {
        const { call } = await makeApp('fake');
        const created = await call(USERS.erin, 'POST', '/api/tickets', {
          title: 'Cannot print',
          description: 'Printer jam',
        });
        const id = created.body.data.id as string;

        let clock = new Date(Date.now() + 3_600_000);
        const r = runner(failing(kind), [], () => clock);
        // Run until the job stops being retried (retryable kinds exhaust their attempts).
        for (let i = 0; i < 6; i++) {
          await r.runOnce();
          clock = new Date(clock.getTime() + 60_000);
        }

        const s = await call(USERS.tom, 'GET', `/api/tickets/${id}/analysis`);
        expect(s.body.data).toMatchObject({
          state: 'FAILED',
          failure: { reason },
          retryAt: null,
          attempts: retryable ? 3 : 1,
          canRetry: true,
        });
        expect(JSON.stringify(s.body)).not.toContain(kind === 'malformed' ? 'zzz' : '"kind"');
        expect(await prisma.aiRecommendation.count({ where: { ticketId: id } })).toBe(0);
        const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id } });
        expect(ticket.status).toBe('OPEN');
        expect(await prisma.ticketEvent.count({ where: { ticketId: id } })).toBe(1); // CREATED only
      },
    );

    it('shows a pending automatic retry with its time and the transient reason', async () => {
      const { call } = await makeApp('fake');
      const created = await call(USERS.erin, 'POST', '/api/tickets', {
        title: 'VPN',
        description: 'down',
      });
      const id = created.body.data.id as string;
      const t0 = new Date(Date.now() + 3_600_000);
      await runner(failing('rate_limited'), [], () => t0).runOnce();
      const s = await call(USERS.tom, 'GET', `/api/tickets/${id}/analysis`);
      expect(s.body.data).toMatchObject({
        state: 'QUEUED',
        attempts: 1,
        failure: { reason: 'rate_limited' },
        canRetry: false,
      });
      expect(new Date(s.body.data.retryAt).getTime()).toBe(t0.getTime() + 1000);
    });

    it('keeps technicians working while AI is down: routing and review paths are unaffected', async () => {
      const { call } = await makeApp('fake');
      const created = await call(USERS.erin, 'POST', '/api/tickets', {
        title: 'Cannot print',
        description: 'Printer jam',
      });
      const id = created.body.data.id as string;
      await runner(failing('unavailable'), [], () => new Date(Date.now() + 3_600_000)).runOnce();

      const routed = await call(USERS.tom, 'POST', `/api/tickets/${id}/routing`, {
        categoryId: CATEGORIES.hardware,
        priority: 'HIGH',
        teamId: TEAMS.hardware,
        expectedVersion: created.body.data.version,
      });
      expect(routed.status).toBe(200);
      const recs = await call(USERS.tom, 'GET', `/api/tickets/${id}/recommendations`);
      expect(recs.status).toBe(200);
      expect(recs.body.data).toEqual([]);
    });
  });

  describe('retry and recovery', () => {
    it('a recovering provider gets a fresh analysis; the failed attempt is left as it was', async () => {
      const { call } = await makeApp('fake');
      const created = await call(USERS.erin, 'POST', '/api/tickets', {
        title: 'Printer paper jam',
        description: 'Print jobs stay queued and the tray is jammed',
      });
      const id = created.body.data.id as string;
      let clock = new Date(Date.now() + 3_600_000);
      const down = runner(
        createFakeProvider(() => new ProviderError('unavailable')),
        [],
        () => clock,
      );
      for (let i = 0; i < 4; i++) {
        await down.runOnce();
        clock = new Date(clock.getTime() + 60_000);
      }
      const failed = await prisma.aiAnalysisJob.findFirstOrThrow({ where: { ticketId: id } });
      expect(failed.state).toBe('FAILED');

      // Provider is back: a technician requests a new analysis.
      const retry = await call(USERS.tom, 'POST', `/api/tickets/${id}/analysis`);
      expect(retry.status).toBe(202);
      expect(retry.body.data).toMatchObject({ state: 'QUEUED', canRetry: false, failure: null });
      expect(retry.body.data.requestId).not.toBe(failed.requestId);

      const up = runner(createFakeProvider());
      await up.runOnce();
      const done = await call(USERS.tom, 'GET', `/api/tickets/${id}/analysis`);
      expect(done.body.data).toMatchObject({ state: 'COMPLETED', failure: null, canRetry: true });
      expect(await prisma.aiRecommendation.count({ where: { ticketId: id } })).toBe(1);

      // History: the failed job is unchanged.
      expect(await prisma.aiAnalysisJob.findUniqueOrThrow({ where: { id: failed.id } })).toEqual(
        failed,
      );
    });

    it('rejects a retry while one is in flight, and is idempotent for the same request id', async () => {
      const { call } = await makeApp('fake');
      const requestId = '00000003-0000-4000-8000-000000000001';
      const first = await call(USERS.tom, 'POST', `/api/tickets/${TICKETS.printer}/analysis`, {
        requestId,
      });
      expect(first.status).toBe(202);
      const replay = await call(USERS.tom, 'POST', `/api/tickets/${TICKETS.printer}/analysis`, {
        requestId,
      });
      expect(replay.status).toBe(200);
      expect(replay.body.data.requestId).toBe(requestId);
      const dup = await call(USERS.tom, 'POST', `/api/tickets/${TICKETS.printer}/analysis`);
      expect(dup.status).toBe(409);
      expect(dup.body.details.code).toBe('ANALYSIS_IN_PROGRESS');
      expect(await prisma.aiAnalysisJob.count({ where: { ticketId: TICKETS.printer } })).toBe(1);
    });

    it('lets exactly one of many simultaneous clicks enqueue', async () => {
      const { call } = await makeApp('fake');
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          call(USERS.tom, 'POST', `/api/tickets/${TICKETS.printer}/analysis`),
        ),
      );
      expect(results.filter((r) => r.status === 202)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      expect(await prisma.aiAnalysisJob.count({ where: { ticketId: TICKETS.printer } })).toBe(1);
    });

    it('rate limits repeated requests per ticket', async () => {
      const { call } = await makeApp('fake');
      for (let i = 0; i < ANALYSES_PER_TICKET_PER_HOUR; i++) {
        const j = await enqueueAnalysis(prisma, { ticketId: TICKETS.printer });
        // Finish each so none is "in flight".
        const c = (await claimNext(prisma, { leaseMs: 1000 }))!;
        await prisma.$executeRaw`UPDATE ai_analysis_jobs SET state = 'FAILED', error_kind = 'timeout',
          lease_token = NULL, locked_until = NULL, completed_at = now() WHERE job_id = ${c.id}::uuid`;
        expect(j.id).toBe(c.id);
      }
      const status = await call(USERS.tom, 'GET', `/api/tickets/${TICKETS.printer}/analysis`);
      expect(status.body.data.canRetry).toBe(false);
      const limited = await call(USERS.tom, 'POST', `/api/tickets/${TICKETS.printer}/analysis`);
      expect(limited.status).toBe(429);
      expect(limited.body.details.code).toBe('ANALYSIS_RATE_LIMITED');
    });

    it('is staff only: requesters get 403 and cannot read status; unreadable tickets are 404', async () => {
      const { call } = await makeApp('fake');
      for (const method of ['GET', 'POST'] as const) {
        const own = await call(USERS.erin, method, `/api/tickets/${TICKETS.printer}/analysis`);
        expect(own.status).toBe(403);
        const other = await call(USERS.omar, method, `/api/tickets/${TICKETS.printer}/analysis`);
        expect(other.status).toBe(404);
      }
      expect(await prisma.aiAnalysisJob.count()).toBe(0);
    });

    it('rejects unknown fields in the request body', async () => {
      const { call } = await makeApp('fake');
      const r = await call(USERS.tom, 'POST', `/api/tickets/${TICKETS.printer}/analysis`, {
        requestId: '00000003-0000-4000-8000-000000000002',
        provider: 'evil',
      });
      expect(r.status).toBe(400);
    });
  });

  describe('worker crash', () => {
    it('a job whose worker keeps dying is a visible FAILED(worker_lost), not a silent hang', async () => {
      const { call } = await makeApp('fake');
      await enqueueAnalysis(prisma, { ticketId: TICKETS.printer, maxAttempts: 2 });
      const t0 = new Date(Date.now() + 3_600_000);
      await claimNext(prisma, { leaseMs: 1000, now: t0 });
      await claimNext(prisma, { leaseMs: 1000, now: new Date(t0.getTime() + 2000) });
      await claimNext(prisma, { leaseMs: 1000, now: new Date(t0.getTime() + 4000) });
      const s = await call(USERS.tom, 'GET', `/api/tickets/${TICKETS.printer}/analysis`);
      expect(s.body.data).toMatchObject({
        state: 'FAILED',
        failure: { reason: 'worker_lost' },
      });
    });
  });

  describe('secrets never leak', () => {
    it('keeps keys, provider messages and ticket text out of logs, job rows and API responses', async () => {
      const { call } = await makeApp('fake');
      const created = await call(USERS.erin, 'POST', '/api/tickets', {
        title: 'VPN fails for the whole office',
        description: `Login says token ${SECRET} and my password is Hunter2Hunter2 rejected.`,
      });
      const id = created.body.data.id as string;

      const logs: JobLogEntry[] = [];
      // The "provider" fails with a message that contains a secret; the unexpected-error path too.
      const leaky = createFakeProvider(() => {
        throw new Error(`upstream 401 for key ${SECRET}: ticket text was Hunter2Hunter2`);
      });
      let clock = new Date(Date.now() + 3_600_000);
      const r = runner(leaky, logs, () => clock);
      for (let i = 0; i < 5; i++) {
        await r.runOnce();
        clock = new Date(clock.getTime() + 60_000);
      }
      const apiDump = JSON.stringify([
        (await call(USERS.tom, 'GET', `/api/tickets/${id}/analysis`)).body,
        (await call(USERS.tom, 'GET', `/api/tickets/${id}/recommendations`)).body,
      ]);
      const rows = JSON.stringify(await prisma.aiAnalysisJob.findMany({ where: { ticketId: id } }));
      const logDump = JSON.stringify(logs);

      for (const dump of [apiDump, rows, logDump]) {
        expect(dump).not.toContain(SECRET);
        expect(dump).not.toContain('Hunter2Hunter2');
        expect(dump).not.toContain('upstream 401');
        expect(dump).not.toContain('VPN fails');
      }
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((l) => l.errorKind === 'internal')).toBe(true);
    });
  });

  describe('deterministic manual cue', () => {
    it.each([
      ['Ransomware note on the file server', 'Files are encrypted', 'Possible security incident'],
      [
        'Email',
        'The whole office has no email, it is an outage',
        'Possible outage affecting many users',
      ],
      ['VPN', 'I am locked out and cannot work', 'Requester cannot work'],
      ['Mouse', 'Please fix ASAP', 'Marked urgent'],
    ])('flags %s', (title, description, reason) => {
      const cue = manualRiskCue(title, description);
      expect(cue.highRisk).toBe(true);
      expect(cue.reasons).toContain(reason);
    });

    it('does not flag routine tickets and never echoes ticket text', () => {
      expect(manualRiskCue('Monitor flickers', 'The second monitor flickers sometimes')).toEqual({
        highRisk: false,
        reasons: [],
      });
      const cue = manualRiskCue('Ransomware at SECRET-PROJECT', 'urgent');
      expect(JSON.stringify(cue)).not.toContain('SECRET-PROJECT');
    });

    it('is shown with the status even when AI never ran, and creates no recommendation', async () => {
      const { call } = await makeApp('none');
      const created = await call(USERS.erin, 'POST', '/api/tickets', {
        title: 'Possible phishing email clicked',
        description: 'I entered my credentials, urgent please',
      });
      const id = created.body.data.id as string;
      const s = await call(USERS.tom, 'GET', `/api/tickets/${id}/analysis`);
      expect(s.body.data.manualCue.highRisk).toBe(true);
      expect(s.body.data.manualCue.reasons).toContain('Possible security incident');
      expect(await prisma.aiRecommendation.count({ where: { ticketId: id } })).toBe(0);
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id } });
      expect(ticket).toMatchObject({ status: 'OPEN', priority: 'UNSET', categoryId: null });
    });
  });
});
