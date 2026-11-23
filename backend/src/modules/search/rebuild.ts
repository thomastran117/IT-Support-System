import type { PrismaClient, TransactionClient } from '@smartdesk/db';
import type { SearchIndexEntityType } from '../../db/repositories/searchIndexJobs.js';
import {
  lockSearchClaims,
  lockSearchRebuildStep,
  sealSearchOutbox,
} from '../../db/repositories/searchRebuilds.js';
import type { Db } from '../../db/transaction.js';
import type { SearchBulkClient, SearchIndexWrite } from './bulk.js';
import { SearchSetupError } from './initialize.js';
import { loadSearchChanges } from './loadSearchChanges.js';
import {
  knowledgeSearchSelect,
  projectKnowledge,
  projectTicket,
  ticketSearchSelect,
} from './projection.js';
import type { SearchRebuildAdmin } from './rebuildAdmin.js';

const BATCH_SIZE = 25;
type Rebuild = NonNullable<Awaited<ReturnType<PrismaClient['searchRebuild']['findUnique']>>>;

interface RebuildOptions {
  prisma: PrismaClient;
  admin: SearchRebuildAdmin;
  bulk: SearchBulkClient;
  version: number;
}

async function sourceCounts(db: Db) {
  const [tickets, articles] = await Promise.all([
    db.ticket.count(),
    db.knowledgeArticle.count({ where: { isPublished: true } }),
  ]);
  return { tickets, articles };
}

function requireNewVersion(version: number, active: number | null) {
  if (active !== null && version <= active) {
    throw new SearchSetupError(`Choose a generation newer than active v${active}`);
  }
}

const readChanges = (tx: TransactionClient, after: bigint, through: bigint, take: number) =>
  tx.searchIndexJob.findMany({
    where: { sequence: { gt: after, lte: through } },
    orderBy: { sequence: 'asc' },
    take,
    select: { sequence: true, entityType: true, entityId: true, revision: true },
  });

/** Each step commits a bounded checkpoint. OpenSearch writes are idempotent if interrupted. */
export function createSearchRebuild({ prisma, admin, bulk, version }: RebuildOptions) {
  async function plan() {
    const [active, counts, checkpoint] = await Promise.all([
      admin.activeVersion(),
      sourceCounts(prisma),
      prisma.searchRebuild.findUnique({ where: { version } }),
    ]);
    if (!checkpoint) requireNewVersion(version, active);
    return { version, activeVersion: active, ...counts, phase: checkpoint?.phase ?? 'NEW' };
  }

  async function write(writes: SearchIndexWrite[]) {
    if (writes.length === 0) return;
    const results = await bulk.write(writes);
    if (results.length !== writes.length || results.some((result) => !result.ok)) {
      throw new SearchSetupError(
        'Replacement index rejected a batch. The checkpoint is ready to retry.',
      );
    }
  }

  async function replay(tx: TransactionClient, changes: Awaited<ReturnType<typeof readChanges>>) {
    const { batch, mismatches } = await loadSearchChanges(
      tx,
      changes.map((job) => ({
        ...job,
        entityType: job.entityType as SearchIndexEntityType,
      })),
    );
    if (mismatches.length)
      throw new SearchSetupError('Outbox revision is newer than its source row');
    await write(batch.map((entry) => entry.write));
  }

  async function cutover(tx: TransactionClient, run: Rebuild) {
    const prepared = run.phase === 'CUTOVER';
    if (!prepared) {
      const other = await tx.searchRebuild.findFirst({
        where: { phase: 'CUTOVER' },
        select: { version: true },
      });
      if (other) throw new SearchSetupError(`Finish pending cutover for v${other.version} first`);
      await lockSearchClaims(tx);
    }

    const active = await admin.activeVersion();
    if (active !== run.sourceVersion && !(prepared && active === version)) {
      throw new SearchSetupError('Live alias generation changed during the rebuild');
    }
    await admin.ensureTargets(version, run.buildId);

    // Source writers take these locks before appending outbox rows. Keep that same lock order.
    await tx.$executeRaw`LOCK TABLE tickets, knowledge_articles IN SHARE MODE`;
    const watermark = await sealSearchOutbox(tx);
    if (watermark < run.replayedThrough)
      throw new SearchSetupError('Outbox watermark moved backwards');
    const changes = await readChanges(tx, run.replayedThrough, watermark, BATCH_SIZE + 1);
    const where = { version };
    if (changes.length > BATCH_SIZE) {
      // Seal another window and release the source locks before replaying a large tail.
      return tx.searchRebuild.update({ where, data: { replayUntil: watermark } });
    }
    await replay(tx, changes);
    const counts = await sourceCounts(tx);
    const actual = await admin.liveCounts(version);
    if (counts.tickets !== actual.tickets || counts.articles !== actual.articles) {
      throw new SearchSetupError(
        `Cannot activate v${version}: PostgreSQL and replacement index counts differ`,
      );
    }

    // Commit the worker pause before sending the alias request. If its acknowledgement is lost,
    // resume this phase, replay queued writes, and inspect which generation now owns the aliases.
    if (prepared && active !== version) await admin.swap(run.sourceVersion, version);
    return tx.searchRebuild.update({
      where,
      data: {
        phase: prepared ? 'COMPLETED' : 'CUTOVER',
        replayUntil: watermark,
        replayedThrough: watermark,
        verifiedTickets: counts.tickets,
        verifiedArticles: counts.articles,
      },
    });
  }

  async function step(): Promise<Rebuild> {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        await lockSearchRebuildStep(tx);
        const where = { version };
        const run = await tx.searchRebuild.findUnique({ where });
        if (!run) {
          const sourceVersion = await admin.activeVersion();
          requireNewVersion(version, sourceVersion);
          return tx.searchRebuild.create({ data: { version, sourceVersion } });
        }
        const cursor = run.scanCursor ? { id: { gt: run.scanCursor } } : {};

        switch (run.phase) {
          case 'COMPLETED':
            return run;
          case 'PREPARE':
            await admin.ensureTargets(version, run.buildId, true);
            return tx.searchRebuild.update({ where, data: { phase: 'TICKETS' } });
          case 'TICKETS': {
            const tickets = await tx.ticket.findMany({
              where: cursor,
              orderBy: { id: 'asc' },
              take: BATCH_SIZE,
              select: ticketSearchSelect,
            });
            await write(tickets.map(projectTicket));
            return tx.searchRebuild.update({
              where,
              data:
                tickets.length < BATCH_SIZE
                  ? { phase: 'KNOWLEDGE', scanCursor: null }
                  : { scanCursor: tickets.at(-1)!.id },
            });
          }
          case 'KNOWLEDGE': {
            const articles = await tx.knowledgeArticle.findMany({
              where: { ...cursor, isPublished: true },
              orderBy: { id: 'asc' },
              take: BATCH_SIZE,
              select: knowledgeSearchSelect,
            });
            await write(articles.map(projectKnowledge));
            return tx.searchRebuild.update({
              where,
              data:
                articles.length < BATCH_SIZE
                  ? { phase: 'REPLAY', scanCursor: null, replayUntil: await sealSearchOutbox(tx) }
                  : { scanCursor: articles.at(-1)!.id },
            });
          }
          case 'REPLAY':
          case 'CUTOVER': {
            if (run.replayedThrough >= run.replayUntil) return cutover(tx, run);
            const changes = await readChanges(tx, run.replayedThrough, run.replayUntil, BATCH_SIZE);
            await replay(tx, changes);
            return tx.searchRebuild.update({
              where,
              data: {
                replayedThrough:
                  changes.length < BATCH_SIZE ? run.replayUntil : changes.at(-1)!.sequence,
              },
            });
          }
          default:
            throw new SearchSetupError('Unknown rebuild checkpoint phase');
        }
      },
      { timeout: 35_000, isolationLevel: 'ReadCommitted' },
    );
  }

  async function run(signal?: AbortSignal): Promise<Rebuild> {
    for (;;) {
      signal?.throwIfAborted();
      const checkpoint = await step();
      if (checkpoint.phase === 'COMPLETED') return checkpoint;
    }
  }

  return { plan, step, run };
}
