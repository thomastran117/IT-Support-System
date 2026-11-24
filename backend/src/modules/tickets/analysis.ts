import type { PrismaClient } from '@smartdesk/db';
import type { AnalysisFailureReason, AnalysisStatusDto } from '@smartdesk/contracts';
import {
  countRecentForTicket,
  enqueueAnalysis,
  findActiveForTicket,
  findByRequest,
  findLatestForTicket,
  type AnalysisJob,
} from '../../db/repositories/aiAnalysisJobs.js';
import { withTransaction } from '../../db/transaction.js';
import { HttpError } from '../../plugins/errors.js';
import { manualRiskCue } from '../ai/riskCue.js';

/** Fresh analyses a ticket may request per hour (the automatic first analysis counts too). */
export const ANALYSES_PER_TICKET_PER_HOUR = 5;
const WINDOW_MS = 60 * 60_000;

/**
 * Stored reason code -> client-safe reason and fixed wording. Unknown codes degrade to `internal`,
 * so nothing stored can ever leak through this mapping.
 */
const FAILURES: Record<string, { reason: AnalysisFailureReason; message: string }> = {
  unavailable: {
    reason: 'provider_unavailable',
    message: 'The AI service was unavailable.',
  },
  timeout: { reason: 'timed_out', message: 'The AI service took too long to respond.' },
  rate_limited: {
    reason: 'rate_limited',
    message: 'The AI service is busy and asked us to slow down.',
  },
  malformed: {
    reason: 'invalid_response',
    message: 'The AI service returned a response that could not be used.',
  },
  invalid_reference: {
    reason: 'invalid_response',
    message: 'The AI service returned a response that could not be used.',
  },
  ticket_missing: { reason: 'ticket_unavailable', message: 'The ticket could not be analysed.' },
  worker_lost: {
    reason: 'worker_lost',
    message: 'The analysis was interrupted and ran out of attempts.',
  },
  disabled: { reason: 'ai_disabled', message: 'AI analysis is switched off.' },
  internal: { reason: 'internal', message: 'The analysis failed unexpectedly.' },
};

export const describeFailure = (kind: string | null) =>
  kind === null ? null : (FAILURES[kind] ?? FAILURES.internal!);

function statusOf(
  job: AnalysisJob | null,
  extra: { enabled: boolean; atLimit: boolean; cue: AnalysisStatusDto['manualCue'] },
): AnalysisStatusDto {
  const inFlight = job?.state === 'QUEUED' || job?.state === 'RUNNING';
  return {
    enabled: extra.enabled,
    state: job?.state ?? 'NONE',
    requestId: job?.requestId ?? null,
    attempts: job?.attempts ?? 0,
    maxAttempts: job?.maxAttempts ?? 0,
    retryAt: job?.state === 'QUEUED' && job.errorKind ? job.runAfter.toISOString() : null,
    failure: job ? describeFailure(job.errorKind) : null,
    updatedAt: job?.updatedAt.toISOString() ?? null,
    canRetry: extra.enabled && !inFlight && !extra.atLimit,
    manualCue: extra.cue,
  };
}

/** Status of the newest analysis, plus the deterministic manual cue. Staff-only; caller authorizes. */
export async function getAnalysisStatus(
  prisma: PrismaClient,
  ticketId: string,
  opts: { enabled: boolean },
): Promise<AnalysisStatusDto> {
  const [ticket, job, recent] = await Promise.all([
    prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { title: true, description: true },
    }),
    findLatestForTicket(prisma, ticketId),
    countRecentForTicket(prisma, ticketId, WINDOW_MS),
  ]);
  return statusOf(job, {
    enabled: opts.enabled,
    atLimit: recent >= ANALYSES_PER_TICKET_PER_HOUR,
    cue: manualRiskCue(ticket.title, ticket.description),
  });
}

/**
 * Ask for a fresh analysis. Always a NEW job with its own request id: an earlier job, proposal or
 * decision is never modified. Guarded so repeated or concurrent clicks cannot flood the provider:
 * - the same `requestId` is idempotent and returns the existing job (`created: false`);
 * - 409 ANALYSIS_IN_PROGRESS while one is already queued or running;
 * - 429 ANALYSIS_RATE_LIMITED after `ANALYSES_PER_TICKET_PER_HOUR` requests in an hour.
 * A per-ticket advisory lock makes those checks and the insert one atomic step.
 */
export async function requestAnalysis(
  prisma: PrismaClient,
  opts: { ticketId: string; requestId?: string; maxAttempts: number; correlationId?: string },
): Promise<{ job: AnalysisJob; created: boolean }> {
  // The transaction helper turns every thrown error into a database error, so refusals are returned
  // as values and raised as HTTP errors once the transaction is over.
  const outcome = await withTransaction(
    prisma,
    async (tx): Promise<{ job: AnalysisJob; created: boolean } | 'in_progress' | 'limited'> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'ai-analysis:' + opts.ticketId}, 0))`;

      if (opts.requestId) {
        const same = await findByRequest(tx, opts.ticketId, opts.requestId);
        if (same) return { job: same, created: false };
      }
      if (await findActiveForTicket(tx, opts.ticketId)) return 'in_progress';
      if (
        (await countRecentForTicket(tx, opts.ticketId, WINDOW_MS)) >= ANALYSES_PER_TICKET_PER_HOUR
      ) {
        return 'limited';
      }
      const job = await enqueueAnalysis(tx, {
        ticketId: opts.ticketId,
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        maxAttempts: opts.maxAttempts,
        correlationId: opts.correlationId,
      });
      return { job, created: true };
    },
  );
  if (outcome === 'in_progress') {
    throw new HttpError(409, 'An analysis is already in progress for this ticket', {
      code: 'ANALYSIS_IN_PROGRESS',
    });
  }
  if (outcome === 'limited') {
    throw new HttpError(429, 'Too many analysis requests for this ticket; try again later', {
      code: 'ANALYSIS_RATE_LIMITED',
    });
  }
  return outcome;
}
