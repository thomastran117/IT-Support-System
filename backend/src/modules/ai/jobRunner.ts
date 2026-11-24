import {
  classifyAnalysisFailure,
  createAnalysisRunner,
  ProviderError,
  type AnalysisDraft,
  type JobLogEntry,
  type AnalysisRunnerConfig,
} from '@smartdesk/ai-analysis';
import type { PrismaClient, TransactionClient } from '@smartdesk/db';
import { DbError } from '../../db/errors.js';
import {
  claimNext,
  completeJob,
  failAttempt,
  type AnalysisJob,
} from '../../db/repositories/aiAnalysisJobs.js';
import { withTransaction } from '../../db/transaction.js';

export type { JobLogEntry };
export type JobRunnerConfig = AnalysisRunnerConfig & { leaseMs: number; backoffBaseMs: number };

export type PersistDraft = (
  tx: TransactionClient,
  ctx: { job: AnalysisJob; draft: AnalysisDraft },
) => Promise<void>;

interface JobRunnerDeps {
  prisma: PrismaClient;
  analysis: { analyse(ticketId: string, requestId?: string): Promise<AnalysisDraft> };
  config: JobRunnerConfig;
  persist?: PersistDraft;
  log?: (entry: JobLogEntry) => void;
  now?: () => Date;
}

/** In-process transport used by the default worker and the rollback path. */
export function createJobRunner(deps: JobRunnerDeps) {
  const { prisma, analysis, config } = deps;
  return createAnalysisRunner({
    config,
    log: deps.log,
    claim: () => claimNext(prisma, { leaseMs: config.leaseMs, now: deps.now?.() }),
    analyse: (job) => analysis.analyse(job.ticketId, job.requestId),
    complete: (job, draft) =>
      withTransaction(prisma, async (tx) => {
        if (!(await completeJob(tx, job, deps.now?.()))) return false;
        await deps.persist?.(tx, { job, draft });
        return true;
      }),
    fail: (job, failure) =>
      failAttempt(prisma, job, {
        errorKind: failure.kind,
        retryable: failure.retryable,
        backoffBaseMs: config.backoffBaseMs,
        now: deps.now?.(),
      }),
    classifyError: (error) =>
      classifyAnalysisFailure(
        error instanceof DbError && error.code === 'NOT_FOUND'
          ? 'ticket_missing'
          : error instanceof ProviderError
            ? error.kind
            : 'internal',
      ),
  });
}
