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

interface DeliveryObservation {
  eventId: string;
  ticketId?: string;
  correlationId?: string;
  eventType?: ServiceEventV1['type'];
  state: 'COMPLETED' | 'QUEUED' | 'FAILED' | 'LOST';
  attempt: number;
  durationMs: number;
}

export async function drainNotificationEvents(
  db: PrismaClient,
  signal?: AbortSignal,
  observe?: (delivery: DeliveryObservation) => void,
) {
  const results = { COMPLETED: 0, QUEUED: 0, FAILED: 0, LOST: 0 };
  for (let index = 0; index < 100 && !signal?.aborted; index++) {
    const claim = await claimServiceEvent(db, notificationSubscription);
    if (!claim) break;
    const started = performance.now();
    const context: Pick<DeliveryObservation, 'ticketId' | 'correlationId' | 'eventType'> = {};
    const state = await deliverServiceEvent(db, claim, async (tx, event) => {
      context.ticketId = event.aggregateId;
      context.correlationId = event.correlationId;
      context.eventType = event.type;
      await applyNotificationEvent(tx, event);
    });
    results[state]++;
    observe?.({
      eventId: claim.eventId,
      ...context,
      state,
      attempt: claim.attempts,
      durationMs: performance.now() - started,
    });
  }
  return results;
}

/** Pause between non-full batches and let the in-flight effect finish during shutdown. */
export async function consumeNotificationEvents(
  db: PrismaClient,
  pollMs: number,
  signal: AbortSignal,
  warn: (message: string) => void,
  observe?: (delivery: DeliveryObservation) => void,
) {
  while (!signal.aborted) {
    try {
      const counts = await drainNotificationEvents(db, signal, observe);
      if (counts.FAILED) warn('Notification events moved to the dead-letter queue');
      if (Object.values(counts).reduce((total, count) => total + count, 0) === 100) continue;
    } catch {
      warn('Notification outbox polling failed');
    }
    await setTimeout(pollMs, undefined, { signal }).catch(() => {});
  }
}
