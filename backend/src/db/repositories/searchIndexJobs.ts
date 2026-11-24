import { Prisma, type PrismaClient, type TransactionClient } from '@smartdesk/db';
import type { Db } from '../transaction.js';
import { searchClaimsPaused } from './searchRebuilds.js';
import type { SearchIndexEntityType } from '@smartdesk/db';

export {
  enqueueSearchIndexJob,
  type SearchIndexEntityType,
  type SearchIndexEventKind,
} from '@smartdesk/db';

export type SearchIndexErrorKind =
  | 'authorization'
  | 'circuit_open'
  | 'index_missing'
  | 'invalid_response'
  | 'rate_limited'
  | 'rejected'
  | 'revision_mismatch'
  | 'timeout'
  | 'unavailable';

export interface ClaimedSearchIndexJob {
  id: string;
  entityType: SearchIndexEntityType;
  entityId: string;
  revision: number;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
}

type SearchLease = Pick<ClaimedSearchIndexJob, 'id' | 'leaseToken'>;

const clock = (now?: Date) =>
  now ? Prisma.sql`${now}::timestamptz` : Prisma.sql`statement_timestamp()`;

const holdsLease = (job: SearchLease, now?: Date) => Prisma.sql`
  job_id = ${job.id}::uuid AND lease_token = ${job.leaseToken}::uuid
  AND state = 'RUNNING' AND locked_until > ${clock(now)}`;

/** Claim due and abandoned jobs with the same leased SKIP LOCKED pattern as AI analysis. */
export async function claimSearchIndexJobs(
  prisma: PrismaClient,
  options: { limit: number; leaseMs: number; now?: Date },
): Promise<ClaimedSearchIndexJob[]> {
  return prisma.$transaction(async (tx) => {
    if (await searchClaimsPaused(tx)) return [];
    return claimDueSearchIndexJobs(tx, options);
  });
}

async function claimDueSearchIndexJobs(
  db: TransactionClient,
  { limit, leaseMs, now }: { limit: number; leaseMs: number; now?: Date },
): Promise<ClaimedSearchIndexJob[]> {
  await db.$executeRaw`
    UPDATE search_index_jobs
    SET state = 'FAILED', error_kind = 'worker_lost', lease_token = NULL, locked_until = NULL,
        completed_at = ${clock(now)}, updated_at = ${clock(now)}
    WHERE state = 'RUNNING' AND locked_until <= ${clock(now)} AND attempts >= max_attempts`;

  return db.$queryRaw<ClaimedSearchIndexJob[]>`
    WITH ready AS (
      SELECT job_id FROM search_index_jobs
      WHERE attempts < max_attempts AND (
        (state = 'QUEUED' AND available_at <= ${clock(now)}) OR
        (state = 'RUNNING' AND locked_until <= ${clock(now)})
      )
      ORDER BY available_at, job_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE search_index_jobs j
    SET state = 'RUNNING', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
        locked_until = ${clock(now)} + make_interval(secs => ${leaseMs / 1000}::float8),
        updated_at = ${clock(now)}
    FROM ready WHERE j.job_id = ready.job_id
    RETURNING j.job_id AS id, j.entity_type AS "entityType", j.entity_id AS "entityId",
              j.revision, j.attempts, j.max_attempts AS "maxAttempts", j.lease_token AS "leaseToken"`;
}

export function completeSearchIndexJob(db: Db, job: SearchLease, now?: Date): Promise<number> {
  return db.$executeRaw`
    UPDATE search_index_jobs
    SET state = 'COMPLETED', error_kind = NULL, lease_token = NULL, locked_until = NULL,
        completed_at = ${clock(now)}, updated_at = ${clock(now)}
    WHERE ${holdsLease(job, now)}`;
}

export function failSearchIndexJob(
  db: Db,
  job: SearchLease,
  errorKind: SearchIndexErrorKind,
  retryAfterMs: number | null,
  now?: Date,
): Promise<number> {
  const state = retryAfterMs === null ? 'FAILED' : 'QUEUED';
  return db.$executeRaw`
    UPDATE search_index_jobs
    SET state = ${state}, error_kind = ${errorKind}, lease_token = NULL, locked_until = NULL,
        available_at = COALESCE(${clock(now)} + make_interval(secs => ${retryAfterMs === null ? null : retryAfterMs / 1000}::float8), available_at),
        completed_at = ${state === 'FAILED' ? clock(now) : Prisma.sql`NULL`},
        updated_at = ${clock(now)}
    WHERE ${holdsLease(job, now)}`;
}

/** Explicitly retry one terminal job. The next claim loads current canonical data again. */
export function requeueFailedSearchIndexJob(db: Db, id: string): Promise<number> {
  return db.$executeRaw`
    UPDATE search_index_jobs
    SET state = 'QUEUED', attempts = 0, available_at = statement_timestamp(),
        updated_at = statement_timestamp(), completed_at = NULL, error_kind = NULL
    WHERE job_id = ${id}::uuid AND state = 'FAILED'`;
}
