import type { ServiceEventType, ServiceEventV1 } from '@smartdesk/contracts';
import { serviceEventV1Schema } from '@smartdesk/contracts';
import { Prisma, type PrismaClient, type TransactionClient } from '@smartdesk/db';
import { withTransaction } from '../transaction.js';

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5000;
const LEASE_MS = 30_000;
const clock = (now?: Date) =>
  now ? Prisma.sql`${now}::timestamptz` : Prisma.sql`clock_timestamp()`;

export interface OutboxSubscription {
  name: string;
  types: readonly [ServiceEventType, ...ServiceEventType[]];
}

interface Claim {
  consumer: string;
  eventId: string;
  leaseToken: string;
  attempts: number;
}

/** Prioritize due retries, then register and claim a committed event for this subscription. */
export async function claimServiceEvent(
  db: PrismaClient,
  subscription: OutboxSubscription,
  now?: Date,
): Promise<Claim | null> {
  const time = clock(now);
  await db.$executeRaw`
    WITH expired AS (
      SELECT event_id FROM service_outbox_deliveries
      WHERE consumer = ${subscription.name} AND state = 'RUNNING'
        AND locked_until <= ${time} AND attempts >= ${MAX_ATTEMPTS}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE service_outbox_deliveries d
    SET state = 'FAILED', error_kind = 'worker_lost', finished_at = ${time},
        lease_token = NULL, locked_until = NULL
    FROM expired
    WHERE d.consumer = ${subscription.name} AND d.event_id = expired.event_id`;

  const [retry] = await db.$queryRaw<Claim[]>`
    WITH pending AS (
      SELECT event_id FROM service_outbox_deliveries
      WHERE consumer = ${subscription.name}
        AND ((state = 'QUEUED' AND run_after <= ${time})
          OR (state = 'RUNNING' AND locked_until <= ${time} AND attempts < ${MAX_ATTEMPTS}))
      ORDER BY run_after, event_id
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE service_outbox_deliveries d
    SET state = 'RUNNING', attempts = d.attempts + 1, lease_token = gen_random_uuid(),
        locked_until = ${time} + ${LEASE_MS} * interval '1 millisecond'
    FROM pending
    WHERE d.consumer = ${subscription.name} AND d.event_id = pending.event_id
    RETURNING d.consumer, d.event_id AS "eventId", d.lease_token AS "leaseToken", d.attempts`;
  if (retry) return retry;

  // The receipt is also the discovery record. A cursor based on timestamps or sequences could
  // skip an event when an older transaction commits after a newer one.
  const [fresh] = await db.$queryRaw<Claim[]>`
    INSERT INTO service_outbox_deliveries
      (consumer, event_id, state, attempts, run_after, lease_token, locked_until)
    SELECT ${subscription.name}, e.event_id, 'RUNNING', 1, e.occurred_at, gen_random_uuid(),
           ${time} + ${LEASE_MS} * interval '1 millisecond'
    FROM service_outbox_events e
    WHERE e.type IN (${Prisma.join(subscription.types)})
      AND NOT EXISTS (
        SELECT 1 FROM service_outbox_deliveries d
        WHERE d.event_id = e.event_id AND d.consumer = ${subscription.name}
      )
    ORDER BY e.occurred_at, e.event_id
    LIMIT 1
    ON CONFLICT (consumer, event_id) DO NOTHING
    RETURNING consumer, event_id AS "eventId", lease_token AS "leaseToken", attempts`;
  return fresh ?? null;
}

type Effect = (tx: TransactionClient, event: ServiceEventV1) => Promise<void>;
type DeliveryResult = 'COMPLETED' | 'QUEUED' | 'FAILED' | 'LOST';

/** The consumer's database effect and its receipt commit together under the active lease. */
export async function deliverServiceEvent(
  db: PrismaClient,
  claim: Claim,
  apply: Effect,
  now?: Date,
): Promise<DeliveryResult> {
  const time = clock(now);
  const lease = Prisma.sql`
    consumer = ${claim.consumer} AND event_id = ${claim.eventId}::uuid
    AND state = 'RUNNING' AND lease_token = ${claim.leaseToken}::uuid AND locked_until > ${time}`;
  const errorKind = await withTransaction(db, async (tx) => {
    const row = await tx.serviceOutboxEvent.findUniqueOrThrow({
      where: { eventId: claim.eventId },
    });
    const parsed = serviceEventV1Schema.safeParse({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
    });
    if (!parsed.success) return 'invalid_event';

    const updated = await tx.$executeRaw`
      UPDATE service_outbox_deliveries
      SET state = 'COMPLETED', finished_at = ${time}, error_kind = NULL,
          lease_token = NULL, locked_until = NULL
      WHERE ${lease}`;
    if (!updated) return 'lost';
    await apply(tx, parsed.data);
    return null;
  }).catch(() => 'handler_failed' as const);
  if (errorKind === 'lost') return 'LOST';
  if (errorKind === null) return 'COMPLETED';

  const retry = errorKind === 'handler_failed' && claim.attempts < MAX_ATTEMPTS;
  const state = retry ? 'QUEUED' : 'FAILED';
  const delayMs = BACKOFF_BASE_MS * 2 ** (claim.attempts - 1);
  const changed = await db.$executeRaw`
    UPDATE service_outbox_deliveries
    SET state = ${state}, error_kind = ${errorKind}, lease_token = NULL, locked_until = NULL,
        run_after = CASE WHEN ${retry} THEN ${time} + ${delayMs} * interval '1 millisecond' ELSE run_after END,
        finished_at = CASE WHEN ${retry} THEN NULL ELSE ${time} END
    WHERE ${lease}`;
  return changed ? state : 'LOST';
}

/** Requeue a dead letter without changing its event ID or touching completed receipts. */
export async function replayServiceEvent(
  db: PrismaClient,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const changed = await db.$executeRaw`
    UPDATE service_outbox_deliveries
    SET state = 'QUEUED', attempts = 0, run_after = clock_timestamp(), finished_at = NULL, error_kind = NULL
    WHERE consumer = ${consumer} AND event_id = ${eventId}::uuid AND state = 'FAILED'`;
  return changed === 1;
}
