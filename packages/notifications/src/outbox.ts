import type { ServiceEventV1 } from '@smartdesk/contracts';
import type { PrismaClient, TransactionClient } from '@smartdesk/db';
import { setTimeout } from 'node:timers/promises';
import { insertInboxNotification } from './inbox.js';
import { claimServiceEvent, deliverServiceEvent } from './serviceOutbox.js';
import type { OutboxSubscription } from './serviceOutbox.js';

export const notificationSubscription = {
  name: 'notifications',
  types: ['ticket.routed', 'ticket.status-changed', 'ticket.public-reply'],
} as const satisfies OutboxSubscription;

/** Each notice is an independent fact, including late events and replies with the same version. */
export async function applyNotificationEvent(tx: TransactionClient, event: ServiceEventV1) {
  const { payload } = event;
  if (!('notification' in payload) || !payload.notification) return;
  await insertInboxNotification(
    tx,
    {
      ...payload.notification,
      ticketId: event.aggregateId,
      eventId: event.eventId,
    },
    event.occurredAt,
  );
}

export async function drainNotificationEvents(db: PrismaClient, signal?: AbortSignal) {
  const results = { COMPLETED: 0, QUEUED: 0, FAILED: 0, LOST: 0 };
  for (let index = 0; index < 100 && !signal?.aborted; index++) {
    const claim = await claimServiceEvent(db, notificationSubscription);
    if (!claim) break;
    results[await deliverServiceEvent(db, claim, applyNotificationEvent)]++;
  }
  return results;
}

/** Pause between non-full batches and let the in-flight effect finish during shutdown. */
export async function consumeNotificationEvents(
  db: PrismaClient,
  pollMs: number,
  signal: AbortSignal,
  warn: (message: string) => void,
) {
  while (!signal.aborted) {
    try {
      const counts = await drainNotificationEvents(db, signal);
      if (counts.FAILED) warn('Notification events moved to the dead-letter queue');
      if (Object.values(counts).reduce((total, count) => total + count, 0) === 100) continue;
    } catch {
      warn('Notification outbox polling failed');
    }
    await setTimeout(pollMs, undefined, { signal }).catch(() => {});
  }
}
