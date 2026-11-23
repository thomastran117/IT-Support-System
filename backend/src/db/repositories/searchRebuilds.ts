import type { TransactionClient } from '@smartdesk/db';

// Serialize maintenance steps independently of the short-lived worker claim gate.
const lockNamespace = 13_004;

export function lockSearchRebuildStep(tx: TransactionClient) {
  return tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${lockNamespace}::int, 1)`;
}

export async function searchClaimsPaused(tx: TransactionClient): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock_shared(${lockNamespace}::int, 2) AS locked`;
  return !row?.locked || (await tx.searchRebuild.count({ where: { phase: 'CUTOVER' } })) !== 0;
}

export function lockSearchClaims(tx: TransactionClient) {
  return tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${lockNamespace}::int, 2)`;
}

export async function sealSearchOutbox(tx: TransactionClient): Promise<bigint> {
  // INSERT holds ROW EXCLUSIVE before its DEFAULT consumes a sequence value. Waiting for that
  // lock to drain seals a committed prefix even if an earlier sequence committed out of order.
  await tx.$executeRaw`LOCK TABLE search_index_jobs IN SHARE MODE`;
  const { _max } = await tx.searchIndexJob.aggregate({ _max: { sequence: true } });
  return _max.sequence ?? 0n;
}
