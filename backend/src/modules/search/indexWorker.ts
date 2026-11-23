import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@smartdesk/db';
import {
  claimSearchIndexJobs,
  completeSearchIndexJob,
  failSearchIndexJob,
  type ClaimedSearchIndexJob,
} from '../../db/repositories/searchIndexJobs.js';
import {
  bulkFailure,
  type SearchBulkClient,
  type SearchIndexResult,
  type SearchIndexWrite,
} from './bulk.js';
import { loadSearchChanges } from './loadSearchChanges.js';
import { SearchError } from './transport.js';

const BATCH_SIZE = 25;
const LEASE_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 15 * 60_000;

interface SearchWorkerLog {
  msg: string;
  jobId?: string;
  state?: string;
  attempt?: number;
  errorKind?: string;
}

interface SearchWorkerOptions {
  prisma: PrismaClient;
  bulk: SearchBulkClient;
  pollIntervalMs: number;
  log?: (entry: SearchWorkerLog) => void;
  now?: () => Date;
  random?: () => number;
}

export function createSearchIndexWorker({
  prisma,
  bulk,
  pollIntervalMs,
  log,
  now,
  random = Math.random,
}: SearchWorkerOptions) {
  let stopSignal: AbortController | undefined;
  let running: Promise<void> | undefined;

  async function settle(job: ClaimedSearchIndexJob, result: SearchIndexResult) {
    if (result.ok) {
      await completeSearchIndexJob(prisma, job, now?.());
      return;
    }
    const allowRetry = result.retryable && job.attempts < job.maxAttempts;
    const retryAfterMs = allowRetry
      ? Math.round(
          Math.min(
            BACKOFF_CAP_MS,
            BACKOFF_BASE_MS * 2 ** (job.attempts - 1) * (1 + 0.25 * random()),
          ),
        )
      : null;
    const updated = await failSearchIndexJob(prisma, job, result.kind, retryAfterMs, now?.());
    log?.({
      msg: 'search indexing attempt failed',
      jobId: job.id,
      attempt: job.attempts,
      state: updated === 0 ? 'LOST' : allowRetry ? 'QUEUED' : 'FAILED',
      errorKind: result.kind,
    });
  }

  async function deliver(writes: SearchIndexWrite[]): Promise<SearchIndexResult[]> {
    if (writes.length === 0) return [];
    try {
      const results = await bulk.write(writes);
      if (results.length !== writes.length) throw new SearchError('invalid_response');
      return results;
    } catch (error) {
      const failure = bulkFailure(error);
      return writes.map(() => failure);
    }
  }

  async function runOnce(): Promise<boolean> {
    const jobs = await claimSearchIndexJobs(prisma, {
      limit: BATCH_SIZE,
      leaseMs: LEASE_MS,
      now: now?.(),
    });
    if (jobs.length === 0) return false;

    const { batch, mismatches } = await loadSearchChanges(prisma, jobs);
    const results = await deliver(batch.map(({ write }) => write));
    const settlements = await Promise.allSettled([
      ...mismatches.map((job) =>
        settle(job, { ok: false, kind: 'revision_mismatch', retryable: false }),
      ),
      ...batch.flatMap((entry, i) => entry.jobs.map((job) => settle(job, results[i]!))),
    ]);
    if (settlements.some((result) => result.status === 'rejected')) {
      throw new Error('Search indexing settlement failed');
    }
    // Back off polling during a complete outage, while each job also has its own retry schedule.
    return results.some((result) => result.ok);
  }

  async function loop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        if (await runOnce()) continue;
      } catch {
        // Database failures leave any claimed leases to expire. Error payloads can contain data.
        log?.({ msg: 'search indexing queue unavailable', errorKind: 'unavailable' });
      }
      if (!signal.aborted) await delay(pollIntervalMs, undefined, { signal }).catch(() => {});
    }
  }

  return {
    runOnce,
    start(): void {
      if (running) return;
      stopSignal = new AbortController();
      running = loop(stopSignal.signal);
    },
    async stop(): Promise<void> {
      stopSignal?.abort();
      await running;
      running = undefined;
      stopSignal = undefined;
    },
  };
}
