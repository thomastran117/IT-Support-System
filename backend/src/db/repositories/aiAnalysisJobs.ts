import { Prisma } from '@smartdesk/db';
import type { Db } from '../transaction.js';
import { hashCorrelationId } from './serviceEvents.js';

export type AnalysisJobState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface AnalysisJob {
  id: string;
  ticketId: string;
  requestId: string;
  state: AnalysisJobState;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  leaseToken: string | null;
  lockedUntil: Date | null;
  errorKind: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

interface JobRow {
  job_id: string;
  ticket_id: string;
  request_id: string;
  state: AnalysisJobState;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  lease_token: string | null;
  locked_until: Date | null;
  error_kind: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const toJob = (r: JobRow): AnalysisJob => ({
  id: r.job_id,
  ticketId: r.ticket_id,
  requestId: r.request_id,
  state: r.state,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  runAfter: r.run_after,
  leaseToken: r.lease_token,
  lockedUntil: r.locked_until,
  errorKind: r.error_kind,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

/** Backoff after the Nth failed attempt: `base * 2^(N-1)` ms, capped. */
export const BACKOFF_CAP_MS = 15 * 60_000;

/** Time source: the database clock unless a test pins it. All lease and backoff maths use one clock. */
const clock = (now?: Date) =>
  now ? Prisma.sql`${now}::timestamptz` : Prisma.sql`clock_timestamp()`;

/**
 * Queue an analysis for a ticket. Idempotent on `(ticketId, requestId)`: repeating a request returns
 * the existing job instead of adding another. Call inside the ticket's transaction so the job exists
 * if and only if the ticket does.
 */
export async function enqueueAnalysis(
  db: Db,
  opts: { ticketId: string; requestId?: string; maxAttempts?: number; correlationId?: string },
): Promise<AnalysisJob> {
  const requestId = opts.requestId ?? null;
  const rows = await db.$queryRaw<JobRow[]>`
    INSERT INTO ai_analysis_jobs (ticket_id, request_id, max_attempts, correlation_id)
    VALUES (${opts.ticketId}::uuid, COALESCE(${requestId}::uuid, gen_random_uuid()),
            ${opts.maxAttempts ?? 3}, ${opts.correlationId ? hashCorrelationId(opts.correlationId) : null})
    ON CONFLICT (ticket_id, request_id) DO NOTHING
    RETURNING *`;
  if (rows[0]) return toJob(rows[0]);
  const [existing] = await db.$queryRaw<JobRow[]>`
    SELECT * FROM ai_analysis_jobs WHERE ticket_id = ${opts.ticketId}::uuid AND request_id = ${requestId}::uuid`;
  return toJob(existing!);
}

/**
 * Give up on jobs whose worker vanished and that have no attempts left, so they become an
 * observable FAILED instead of being claimed forever.
 */
export function failAbandoned(db: Db, now?: Date): Promise<number> {
  return db.$executeRaw`
    UPDATE ai_analysis_jobs
    SET state = 'FAILED', error_kind = 'worker_lost', lease_token = NULL, locked_until = NULL,
        completed_at = ${clock(now)}, updated_at = ${clock(now)}
    WHERE state = 'RUNNING' AND locked_until < ${clock(now)} AND attempts >= max_attempts`;
}

/**
 * Atomically take the next due job: QUEUED and due, or RUNNING with an expired lease (its worker
 * died). `SKIP LOCKED` means concurrent workers never block on or double-take the same row. Each
 * claim counts as an attempt and rotates the lease token, which fences off any stale worker.
 */
export async function claimNext(
  db: Db,
  opts: { leaseMs: number; now?: Date },
): Promise<AnalysisJob | null> {
  await failAbandoned(db, opts.now);
  const rows = await db.$queryRaw<JobRow[]>`
    WITH next AS (
      SELECT job_id FROM ai_analysis_jobs
      WHERE (state = 'QUEUED' AND run_after <= ${clock(opts.now)})
         OR (state = 'RUNNING' AND locked_until < ${clock(opts.now)})
      ORDER BY run_after, created_at, job_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ai_analysis_jobs j
    SET state = 'RUNNING',
        attempts = j.attempts + 1,
        lease_token = gen_random_uuid(),
        locked_until = ${clock(opts.now)} + make_interval(secs => ${opts.leaseMs / 1000}::float8),
        updated_at = ${clock(opts.now)}
    FROM next
    WHERE j.job_id = next.job_id
    RETURNING j.*`;
  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * Mark the job COMPLETED, but only for the worker that still holds the lease. Returns false when the
 * lease was lost (expired and re-claimed, or already finished): the caller must then discard its
 * result, which is what makes duplicate delivery harmless. Run it in the same transaction as any
 * write that must happen exactly once per job.
 */
export async function completeJob(
  db: Db,
  job: Pick<AnalysisJob, 'id' | 'leaseToken'>,
  now?: Date,
): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE ai_analysis_jobs
    SET state = 'COMPLETED', error_kind = NULL, lease_token = NULL, locked_until = NULL,
        completed_at = ${clock(now)}, updated_at = ${clock(now)}
    WHERE job_id = ${job.id}::uuid AND lease_token = ${job.leaseToken}::uuid AND state = 'RUNNING'`;
  return n === 1;
}

/**
 * Record a failed attempt for the lease holder. A retryable failure with attempts left goes back to
 * QUEUED after an exponential backoff; anything else is terminal FAILED with a reason code.
 * Returns the resulting state, or null when the lease was already lost.
 */
export async function failAttempt(
  db: Db,
  job: Pick<AnalysisJob, 'id' | 'leaseToken'>,
  opts: { errorKind: string; retryable: boolean; backoffBaseMs: number; now?: Date },
): Promise<'QUEUED' | 'FAILED' | null> {
  const rows = await db.$queryRaw<{ state: 'QUEUED' | 'FAILED' }[]>`
    UPDATE ai_analysis_jobs
    SET state = CASE WHEN ${opts.retryable} AND attempts < max_attempts THEN 'QUEUED' ELSE 'FAILED' END,
        run_after = CASE WHEN ${opts.retryable} AND attempts < max_attempts
          THEN ${clock(opts.now)} + make_interval(
            secs => LEAST(${opts.backoffBaseMs}::float8 * power(2, attempts - 1), ${BACKOFF_CAP_MS}::float8) / 1000.0)
          ELSE run_after END,
        completed_at = CASE WHEN ${opts.retryable} AND attempts < max_attempts THEN NULL ELSE ${clock(opts.now)} END,
        error_kind = ${opts.errorKind},
        lease_token = NULL, locked_until = NULL, updated_at = ${clock(opts.now)}
    WHERE job_id = ${job.id}::uuid AND lease_token = ${job.leaseToken}::uuid AND state = 'RUNNING'
    RETURNING state`;
  return rows[0]?.state ?? null;
}

/** Newest analysis job for a ticket (any state), for status display. */
export async function findLatestForTicket(db: Db, ticketId: string): Promise<AnalysisJob | null> {
  const rows = await db.$queryRaw<JobRow[]>`
    SELECT * FROM ai_analysis_jobs WHERE ticket_id = ${ticketId}::uuid
    ORDER BY created_at DESC, job_id DESC LIMIT 1`;
  return rows[0] ? toJob(rows[0]) : null;
}

/** The job that is currently waiting or being worked on for a ticket, if any. */
export async function findActiveForTicket(db: Db, ticketId: string): Promise<AnalysisJob | null> {
  const rows = await db.$queryRaw<JobRow[]>`
    SELECT * FROM ai_analysis_jobs
    WHERE ticket_id = ${ticketId}::uuid AND state IN ('QUEUED', 'RUNNING')
    ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ? toJob(rows[0]) : null;
}

export async function findByRequest(
  db: Db,
  ticketId: string,
  requestId: string,
): Promise<AnalysisJob | null> {
  const rows = await db.$queryRaw<JobRow[]>`
    SELECT * FROM ai_analysis_jobs
    WHERE ticket_id = ${ticketId}::uuid AND request_id = ${requestId}::uuid`;
  return rows[0] ? toJob(rows[0]) : null;
}

/** Jobs created for a ticket in the last `windowMs`, for per-ticket request limiting. */
export async function countRecentForTicket(
  db: Db,
  ticketId: string,
  windowMs: number,
): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM ai_analysis_jobs
    WHERE ticket_id = ${ticketId}::uuid
      AND created_at > clock_timestamp() - make_interval(secs => ${windowMs / 1000}::float8)`;
  return Number(rows[0]?.n ?? 0);
}
