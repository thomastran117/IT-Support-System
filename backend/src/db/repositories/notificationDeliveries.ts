import { Prisma } from '@smartdesk/db';
import type { NotificationType } from '@smartdesk/contracts';
import type { Db } from '../transaction.js';

export type DeliveryState = 'QUEUED' | 'RUNNING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface Delivery {
  id: string;
  notificationId: string;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
}

/** Backoff after the Nth failed attempt: `base * 2^(N-1)` ms, capped. */
export const EMAIL_BACKOFF_CAP_MS = 60 * 60_000;

/** The database clock unless a test pins it, so leases, backoff and expiry share one clock. */
const clock = (now?: Date) =>
  now ? Prisma.sql`${now}::timestamptz` : Prisma.sql`clock_timestamp()`;

/**
 * Queue an email delivery for every recent notification that has none yet. Idempotent: the unique
 * key on `notification_id` means a notification is queued at most once however often this runs,
 * and a notification that was already sent or skipped is never queued again. Notifications older
 * than `maxAgeMs` are ignored, so enabling email later does not mail the whole history.
 */
export function enqueueRecent(
  db: Db,
  opts: { maxAgeMs: number; maxAttempts: number; now?: Date },
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    INSERT INTO notification_deliveries (notification_id, max_attempts, run_after)
    SELECT n.notification_id, ${opts.maxAttempts}, ${clock(opts.now)}
    FROM notifications n
    WHERE n.created_at > ${clock(opts.now)} - make_interval(secs => ${opts.maxAgeMs / 1000}::float8)
    ON CONFLICT (notification_id) DO NOTHING`);
}

/** Stop waiting for deliveries that outlived `maxAgeMs` (for example after a long outage). */
export function expireStale(db: Db, opts: { maxAgeMs: number; now?: Date }): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE notification_deliveries
    SET state = 'SKIPPED', error_kind = 'expired', completed_at = ${clock(opts.now)},
        updated_at = ${clock(opts.now)}
    WHERE state = 'QUEUED'
      AND created_at < ${clock(opts.now)} - make_interval(secs => ${opts.maxAgeMs / 1000}::float8)`);
}

/** Fail deliveries whose worker vanished and that have no attempts left. */
export function failAbandoned(db: Db, now?: Date): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE notification_deliveries
    SET state = 'FAILED', error_kind = 'worker_lost', lease_token = NULL, locked_until = NULL,
        completed_at = ${clock(now)}, updated_at = ${clock(now)}
    WHERE state = 'RUNNING' AND locked_until < ${clock(now)} AND attempts >= max_attempts`);
}

interface ClaimRow {
  delivery_id: string;
  notification_id: string;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

/**
 * Atomically take the next due delivery (QUEUED and due, or RUNNING with an expired lease). Each
 * claim counts as an attempt and rotates the lease token, which fences off any stale worker.
 */
export async function claimNext(
  db: Db,
  opts: { leaseMs: number; now?: Date },
): Promise<Delivery | null> {
  await failAbandoned(db, opts.now);
  const rows = await db.$queryRaw<ClaimRow[]>(Prisma.sql`
    WITH next AS (
      SELECT delivery_id FROM notification_deliveries
      WHERE (state = 'QUEUED' AND run_after <= ${clock(opts.now)})
         OR (state = 'RUNNING' AND locked_until < ${clock(opts.now)})
      ORDER BY run_after, created_at, delivery_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE notification_deliveries d
    SET state = 'RUNNING',
        attempts = d.attempts + 1,
        lease_token = gen_random_uuid(),
        locked_until = ${clock(opts.now)} + make_interval(secs => ${opts.leaseMs / 1000}::float8),
        updated_at = ${clock(opts.now)}
    FROM next
    WHERE d.delivery_id = next.delivery_id
    RETURNING d.delivery_id, d.notification_id, d.attempts, d.max_attempts, d.lease_token`);
  const r = rows[0];
  return r
    ? {
        id: r.delivery_id,
        notificationId: r.notification_id,
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
        leaseToken: r.lease_token,
      }
    : null;
}

/**
 * Finish the delivery for the lease holder: SENT, or SKIPPED with a reason code. Returns false when
 * the lease was lost (expired and re-claimed, or already finished).
 */
export async function finish(
  db: Db,
  delivery: Pick<Delivery, 'id' | 'leaseToken'>,
  outcome: { state: 'SENT' | 'SKIPPED'; reason?: string },
  now?: Date,
): Promise<boolean> {
  const n = await db.$executeRaw(Prisma.sql`
    UPDATE notification_deliveries
    SET state = ${outcome.state}, error_kind = ${outcome.reason ?? null}, lease_token = NULL,
        locked_until = NULL, completed_at = ${clock(now)}, updated_at = ${clock(now)}
    WHERE delivery_id = ${delivery.id}::uuid AND lease_token = ${delivery.leaseToken}::uuid
      AND state = 'RUNNING'`);
  return n === 1;
}

/**
 * Record a failed attempt for the lease holder. A retryable failure with attempts left goes back to
 * QUEUED after an exponential backoff; anything else is terminal FAILED with a reason code.
 */
export async function failAttempt(
  db: Db,
  delivery: Pick<Delivery, 'id' | 'leaseToken'>,
  opts: { errorKind: string; retryable: boolean; backoffBaseMs: number; now?: Date },
): Promise<'QUEUED' | 'FAILED' | null> {
  const rows = await db.$queryRaw<{ state: 'QUEUED' | 'FAILED' }[]>(Prisma.sql`
    UPDATE notification_deliveries
    SET state = CASE WHEN ${opts.retryable} AND attempts < max_attempts THEN 'QUEUED' ELSE 'FAILED' END,
        run_after = CASE WHEN ${opts.retryable} AND attempts < max_attempts
          THEN ${clock(opts.now)} + make_interval(
            secs => LEAST(${opts.backoffBaseMs}::float8 * power(2, attempts - 1), ${EMAIL_BACKOFF_CAP_MS}::float8) / 1000.0)
          ELSE run_after END,
        completed_at = CASE WHEN ${opts.retryable} AND attempts < max_attempts THEN NULL ELSE ${clock(opts.now)} END,
        error_kind = ${opts.errorKind},
        lease_token = NULL, locked_until = NULL, updated_at = ${clock(opts.now)}
    WHERE delivery_id = ${delivery.id}::uuid AND lease_token = ${delivery.leaseToken}::uuid
      AND state = 'RUNNING'
    RETURNING state`);
  return rows[0]?.state ?? null;
}

export interface DeliveryContext {
  type: NotificationType;
  ticketId: string;
  ticketTitle: string;
  readAt: Date | null;
  recipientEmail: string;
  recipientName: string;
  recipientActive: boolean;
}

/** Everything the email needs, read fresh at send time. No comment or note text is ever selected. */
export async function loadContext(db: Db, notificationId: string): Promise<DeliveryContext | null> {
  const rows = await db.$queryRaw<
    {
      type: NotificationType;
      ticket_id: string;
      title: string;
      read_at: Date | null;
      email: string;
      display_name: string;
      is_active: boolean;
    }[]
  >(Prisma.sql`
    SELECT n.type, n.ticket_id, t.title, n.read_at, u.email, u.display_name, u.is_active
    FROM notifications n
    JOIN tickets t ON t.ticket_id = n.ticket_id
    JOIN users u ON u.user_id = n.recipient_id
    WHERE n.notification_id = ${notificationId}::uuid`);
  const r = rows[0];
  return r
    ? {
        type: r.type,
        ticketId: r.ticket_id,
        ticketTitle: r.title,
        readAt: r.read_at,
        recipientEmail: r.email,
        recipientName: r.display_name,
        recipientActive: r.is_active,
      }
    : null;
}
