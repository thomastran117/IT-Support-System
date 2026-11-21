import type { PrismaClient, TransactionClient } from '@smartdesk/db';
import { DbError } from '../../db/errors.js';
import {
  claimNext,
  completeJob,
  failAttempt,
  type AnalysisJob,
} from '../../db/repositories/aiAnalysisJobs.js';
import { withTransaction } from '../../db/transaction.js';
import type { AnalysisDraft } from './analysisService.js';
import { ProviderError } from './provider.js';

export interface JobRunnerConfig {
  /** Parallel jobs this process works on. */
  concurrency: number;
  /** Sleep between claim attempts when the queue is empty. */
  pollIntervalMs: number;
  /** Base of the exponential retry backoff. */
  backoffBaseMs: number;
  /** Hard cap on one analysis, after which the attempt fails as a retryable timeout. */
  handlerTimeoutMs: number;
  /** How long a claim is valid; must exceed `handlerTimeoutMs` so a live worker never loses its lease. */
  leaseMs: number;
}

export interface JobLogEntry {
  msg: string;
  jobId?: string;
  ticketId?: string;
  requestId?: string;
  attempt?: number;
  state?: string;
  errorKind?: string;
}

/**
 * What a finished analysis does with its draft. It runs inside the same transaction that marks the
 * job COMPLETED and only if this worker still holds the lease, so anything written here (the
 * recommendation, SD-036) happens exactly once per job even under duplicate delivery.
 */
export type PersistDraft = (
  tx: TransactionClient,
  ctx: { job: AnalysisJob; draft: AnalysisDraft },
) => Promise<void>;

export interface JobRunnerDeps {
  prisma: PrismaClient;
  analysis: { analyse(ticketId: string): Promise<AnalysisDraft> };
  config: JobRunnerConfig;
  persist?: PersistDraft;
  /** Structured log sink. Entries carry ids and reason codes only: never ticket text, keys or messages. */
  log?: (entry: JobLogEntry) => void;
  /** Test hook: pin the clock used for leases and backoff. */
  now?: () => Date;
}

/** Classify any failure into a stored reason code. Messages are never stored or logged. */
export function classifyError(err: unknown): { kind: string; retryable: boolean } {
  if (err instanceof ProviderError) return { kind: err.kind, retryable: err.retryable };
  if (err instanceof DbError && err.code === 'NOT_FOUND') {
    return { kind: 'ticket_missing', retryable: false };
  }
  return { kind: 'internal', retryable: true };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError('timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createJobRunner(deps: JobRunnerDeps) {
  const { prisma, analysis, config } = deps;
  const log = deps.log ?? (() => {});
  const now = () => deps.now?.();

  let stopping = false;
  const wakers = new Set<() => void>();
  let loops: Promise<void>[] = [];

  const ids = (job: AnalysisJob): Omit<JobLogEntry, 'msg'> => ({
    jobId: job.id,
    ticketId: job.ticketId,
    requestId: job.requestId,
    attempt: job.attempts,
  });

  async function process(job: AnalysisJob): Promise<void> {
    log({ msg: 'analysis started', ...ids(job) });
    let draft: AnalysisDraft;
    try {
      draft = await withTimeout(analysis.analyse(job.ticketId), config.handlerTimeoutMs);
    } catch (err) {
      const { kind, retryable } = classifyError(err);
      const state = await failAttempt(prisma, job, {
        errorKind: kind,
        retryable,
        backoffBaseMs: config.backoffBaseMs,
        now: now(),
      });
      log({
        msg: state ? 'analysis failed' : 'analysis failed (lease lost)',
        ...ids(job),
        state: state ?? 'LOST',
        errorKind: kind,
      });
      return;
    }

    try {
      const done = await withTransaction(prisma, async (tx) => {
        if (!(await completeJob(tx, job, now()))) return false;
        await deps.persist?.(tx, { job, draft });
        return true;
      });
      log({
        msg: done ? 'analysis completed' : 'analysis result discarded (lease lost)',
        ...ids(job),
        state: done ? 'COMPLETED' : 'LOST',
      });
    } catch (err) {
      // Persisting failed: nothing was committed, so this is an ordinary failed attempt.
      const { kind, retryable } = classifyError(err);
      await failAttempt(prisma, job, {
        errorKind: kind,
        retryable,
        backoffBaseMs: config.backoffBaseMs,
        now: now(),
      });
      log({ msg: 'analysis failed', ...ids(job), errorKind: kind });
    }
  }

  /** Claim and run one due job. Resolves true when a job was processed, false when none was due. */
  async function runOnce(): Promise<boolean> {
    const job = await claimNext(prisma, { leaseMs: config.leaseMs, now: now() });
    if (!job) return false;
    await process(job);
    return true;
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      wakers.add(wake);
    });

  async function loop(): Promise<void> {
    while (!stopping) {
      try {
        if (await runOnce()) continue;
      } catch (err) {
        // The database itself failed (down, restarting). Back off and keep the loop alive.
        log({ msg: 'queue error', errorKind: classifyError(err).kind });
      }
      if (!stopping) await sleep(config.pollIntervalMs);
    }
  }

  return {
    runOnce,
    /** Start `concurrency` independent claim loops. */
    start(): void {
      if (loops.length > 0) return;
      stopping = false;
      loops = Array.from({ length: config.concurrency }, () => loop());
      log({ msg: 'worker started', attempt: config.concurrency });
    },
    /**
     * Graceful stop: no new claims, in-flight analyses finish (or hit their own timeout). Anything
     * still unfinished afterwards simply has its lease expire and is retried by another worker.
     */
    async stop(): Promise<void> {
      stopping = true;
      for (const wake of [...wakers]) wake();
      await Promise.all(loops);
      loops = [];
      log({ msg: 'worker stopped' });
    },
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;
