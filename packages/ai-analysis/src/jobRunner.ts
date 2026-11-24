import type { AnalysisDraft, AnalysisRetrieval } from './analysis.js';
import { classifyAnalysisFailure, ProviderError } from './provider.js';

interface Job {
  id: string;
  ticketId: string;
  requestId: string;
  correlationId?: string | null;
  attempts: number;
}

export interface AnalysisRunnerConfig {
  /** Parallel jobs this process works on. */
  concurrency: number;
  /** Sleep between claim attempts when the queue is empty. */
  pollIntervalMs: number;
  /** Hard cap on one analysis, after which the attempt fails as a retryable timeout. */
  handlerTimeoutMs: number;
}

export interface JobLogEntry {
  msg: string;
  jobId?: string;
  ticketId?: string;
  requestId?: string;
  originCorrelationId?: string;
  attempt?: number;
  state?: string;
  errorKind?: string;
  retrieval?: AnalysisRetrieval;
  durationMs?: number;
}

export interface AnalysisRunnerDeps<T extends Job> {
  config: AnalysisRunnerConfig;
  claim(): Promise<T | null>;
  analyse(job: T): Promise<AnalysisDraft>;
  complete(job: T, draft: AnalysisDraft): Promise<boolean>;
  fail(
    job: T,
    error: ReturnType<typeof classifyAnalysisFailure>,
  ): Promise<'QUEUED' | 'FAILED' | null>;
  classifyError?(err: unknown): ReturnType<typeof classifyAnalysisFailure>;
  log?(entry: JobLogEntry): void;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError('timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createAnalysisRunner<T extends Job>(deps: AnalysisRunnerDeps<T>) {
  const { config } = deps;
  const log = deps.log ?? (() => {});
  const classifyError =
    deps.classifyError ??
    ((err) => classifyAnalysisFailure(err instanceof ProviderError ? err.kind : 'internal'));

  let stopping = false;
  const wakers = new Set<() => void>();
  let loops: Promise<void>[] = [];

  const ids = (job: T): Omit<JobLogEntry, 'msg'> => ({
    jobId: job.id,
    ticketId: job.ticketId,
    requestId: job.requestId,
    ...(job.correlationId && { originCorrelationId: job.correlationId }),
    attempt: job.attempts,
  });

  async function process(job: T): Promise<void> {
    const started = performance.now();
    log({ msg: 'analysis started', ...ids(job) });
    try {
      const draft = await withTimeout(deps.analyse(job), config.handlerTimeoutMs);
      const done = await deps.complete(job, draft);
      log({
        msg: done ? 'analysis completed' : 'analysis result discarded (lease lost)',
        ...ids(job),
        state: done ? 'COMPLETED' : 'LOST',
        retrieval: draft.retrieval,
        durationMs: performance.now() - started,
      });
    } catch (err) {
      // The queue rejects failure reports after completion, including when its response was lost.
      const failure = classifyError(err);
      const state = await deps.fail(job, failure).catch((updateError: unknown) => {
        log({
          msg: 'analysis failure could not be recorded',
          ...ids(job),
          errorKind: classifyError(updateError).kind,
          durationMs: performance.now() - started,
        });
        throw updateError;
      });
      log({
        msg: state ? 'analysis failed' : 'analysis failed (lease lost)',
        ...ids(job),
        state: state ?? 'LOST',
        errorKind: failure.kind,
        durationMs: performance.now() - started,
      });
    }
  }

  /** Claim and run one due job. Resolves true when a job was processed, false when none was due. */
  async function runOnce(): Promise<boolean> {
    const job = await deps.claim();
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
        // The queue transport failed. Back off and keep the loop alive.
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
