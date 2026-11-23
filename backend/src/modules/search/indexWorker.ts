import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@smartdesk/db';
import {
  claimSearchIndexJobs,
  completeSearchIndexJob,
  failSearchIndexJob,
  type ClaimedSearchIndexJob,
  type SearchIndexEntityType,
} from '../../db/repositories/searchIndexJobs.js';
import {
  bulkFailure,
  type SearchBulkClient,
  type SearchIndexResult,
  type SearchIndexWrite,
} from './bulk.js';
import {
  knowledgeSearchSelect,
  projectKnowledge,
  projectRemoval,
  projectTicket,
  ticketSearchSelect,
} from './projection.js';
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

function entityIds(jobs: ClaimedSearchIndexJob[], type: SearchIndexEntityType): string[] {
  return [...new Set(jobs.filter((job) => job.entityType === type).map((job) => job.entityId))];
}

/** Keep removals at least as new as any durable revision, even if the source row is gone. */
async function missingRevisions(
  prisma: PrismaClient,
  entityType: SearchIndexEntityType,
  ids: string[],
) {
  if (ids.length === 0) return new Map<string, number>();
  const revisions = await prisma.searchIndexJob.groupBy({
    by: ['entityId'],
    where: { entityType, entityId: { in: ids } },
    _max: { revision: true },
  });
  return new Map(revisions.map((row) => [row.entityId, row._max.revision ?? 0]));
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

    const ticketIds = entityIds(jobs, 'TICKET');
    const articleIds = entityIds(jobs, 'KNOWLEDGE_ARTICLE');
    const [ticketRows, articleRows] = await Promise.all([
      ticketIds.length
        ? prisma.ticket.findMany({ where: { id: { in: ticketIds } }, select: ticketSearchSelect })
        : [],
      articleIds.length
        ? prisma.knowledgeArticle.findMany({
            where: { id: { in: articleIds } },
            select: knowledgeSearchSelect,
          })
        : [],
    ]);
    const tickets = new Map(ticketRows.map((row) => [row.id, row]));
    const articles = new Map(articleRows.map((row) => [row.id, row]));
    const [removedTickets, removedArticles] = await Promise.all([
      missingRevisions(
        prisma,
        'TICKET',
        ticketIds.filter((id) => !tickets.has(id)),
      ),
      missingRevisions(
        prisma,
        'KNOWLEDGE_ARTICLE',
        articleIds.filter((id) => !articles.has(id)),
      ),
    ]);

    // A batch may contain several jobs for the same entity. Write its current projection once.
    const pending = new Map<string, { write: SearchIndexWrite; jobs: ClaimedSearchIndexJob[] }>();
    const mismatches: ClaimedSearchIndexJob[] = [];
    for (const job of jobs) {
      const ticket = job.entityType === 'TICKET' ? tickets.get(job.entityId) : undefined;
      const article =
        job.entityType === 'KNOWLEDGE_ARTICLE' ? articles.get(job.entityId) : undefined;
      const revision = ticket?.version ?? article?.searchRevision;
      if (revision !== undefined && revision < job.revision) {
        mismatches.push(job);
        continue;
      }

      const key = `${job.entityType}:${job.entityId}`;
      const existing = pending.get(key);
      if (existing) {
        existing.jobs.push(job);
        continue;
      }
      const removed = job.entityType === 'TICKET' ? removedTickets : removedArticles;
      const write = ticket
        ? projectTicket(ticket)
        : article
          ? projectKnowledge(article)
          : projectRemoval(
              job.entityType,
              job.entityId,
              Math.max(job.revision, removed.get(job.entityId) ?? 0),
            );
      pending.set(key, { write, jobs: [job] });
    }

    const batch = [...pending.values()];
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
