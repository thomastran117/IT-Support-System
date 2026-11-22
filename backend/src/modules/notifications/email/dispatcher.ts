import type { PrismaClient } from '@smartdesk/db';
import {
  claimNext,
  enqueueRecent,
  expireStale,
  failAttempt,
  finish,
  loadContext,
  type Delivery,
} from '../../../db/repositories/notificationDeliveries.js';
import { classifySmtpError, type EmailTransport } from './transport.js';
import { buildEmail } from './template.js';

export interface DispatcherConfig {
  appBaseUrl: string;
  maxAttempts: number;
  backoffBaseMs: number;
  maxAgeMs: number;
  pollIntervalMs: number;
  /** Hard cap on one send; the attempt then fails as a retryable timeout. */
  sendTimeoutMs: number;
  /** Claim validity; must exceed `sendTimeoutMs` so a live worker never loses its lease. */
  leaseMs: number;
}

/** Ids and reason codes only: never addresses, ticket text, message content or credentials. */
export interface DispatchLogEntry {
  msg: string;
  deliveryId?: string;
  notificationId?: string;
  attempt?: number;
  state?: string;
  errorKind?: string;
}

export interface DispatcherDeps {
  prisma: PrismaClient;
  transport: EmailTransport;
  config: DispatcherConfig;
  log?: (entry: DispatchLogEntry) => void;
  /** Test hook: pin the clock used for leases, backoff and expiry. */
  now?: () => Date;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sends notification emails after the in-app notification is durable. It only ever reads
 * notifications and writes its own `notification_deliveries` rows, so a failing or disabled mail
 * server cannot touch a ticket or hide an in-app item. At most one delivery row exists per
 * notification and it is leased while being sent, so a retry never sends a notification that was
 * already delivered. (Unavoidable limit: if the process dies after the mail server accepted the
 * message but before the row is marked SENT, the lease expires and the message is sent once more.
 * The stable Message-ID lets the receiving system recognise that repeat.)
 */
export function createEmailDispatcher(deps: DispatcherDeps) {
  const { prisma, transport, config } = deps;
  const log = deps.log ?? (() => {});
  const now = () => deps.now?.();

  async function deliver(delivery: Delivery): Promise<void> {
    const base: DispatchLogEntry = {
      msg: 'email delivery',
      deliveryId: delivery.id,
      notificationId: delivery.notificationId,
      attempt: delivery.attempts,
    };
    const skip = async (reason: string) => {
      const done = await finish(prisma, delivery, { state: 'SKIPPED', reason }, now());
      log({ ...base, state: done ? 'SKIPPED' : 'LEASE_LOST', errorKind: reason });
    };

    const ctx = await loadContext(prisma, delivery.notificationId);
    if (!ctx || !ctx.recipientActive) return skip('no_recipient');
    // The employee already saw it in the app, so an email would only be noise.
    if (ctx.readAt) return skip('already_read');

    const message = buildEmail({
      notificationId: delivery.notificationId,
      type: ctx.type,
      ticketId: ctx.ticketId,
      ticketTitle: ctx.ticketTitle,
      recipientEmail: ctx.recipientEmail,
      recipientName: ctx.recipientName,
      appBaseUrl: config.appBaseUrl,
    });

    try {
      await withTimeout(transport.send(message), config.sendTimeoutMs);
    } catch (err) {
      const { kind, retryable } = classifySmtpError(err);
      const state = await failAttempt(prisma, delivery, {
        errorKind: kind,
        retryable,
        backoffBaseMs: config.backoffBaseMs,
        now: now(),
      });
      log({ ...base, state: state ?? 'LEASE_LOST', errorKind: kind });
      return;
    }
    const done = await finish(prisma, delivery, { state: 'SENT' }, now());
    log({ ...base, state: done ? 'SENT' : 'LEASE_LOST' });
  }

  /** Queue what is new, then work through every delivery that is due. Returns how many it handled. */
  async function tick(): Promise<number> {
    await enqueueRecent(prisma, {
      maxAgeMs: config.maxAgeMs,
      maxAttempts: config.maxAttempts,
      now: now(),
    });
    await expireStale(prisma, { maxAgeMs: config.maxAgeMs, now: now() });
    let handled = 0;
    for (;;) {
      const next = await claimNext(prisma, { leaseMs: config.leaseMs, now: now() });
      if (!next) return handled;
      handled++;
      try {
        await deliver(next);
      } catch (err) {
        // A database hiccup while handling one delivery must not stop the loop. The lease expires
        // and the delivery is claimed again.
        log({
          msg: 'email delivery error',
          deliveryId: next.id,
          errorKind: classifySmtpError(err).kind,
        });
      }
    }
  }

  let stopping = false;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;

  async function run(): Promise<void> {
    while (!stopping) {
      try {
        await tick();
      } catch {
        log({ msg: 'email dispatcher tick failed', errorKind: 'internal' });
      }
      if (stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, config.pollIntervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  }

  return {
    tick,
    start() {
      if (!loop) loop = run();
    },
    async stop() {
      stopping = true;
      wake?.();
      await loop;
    },
  };
}
