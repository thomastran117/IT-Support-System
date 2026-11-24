import { randomUUID } from 'node:crypto';
import { serviceEventV1Schema } from '@smartdesk/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hashCorrelationId } from '../../src/db/repositories/serviceEvents.js';
import {
  claimServiceEvent,
  deliverServiceEvent,
  replayServiceEvent,
} from '@smartdesk/notifications';
import { appendEvent } from '../../src/db/repositories/ticketEvents.js';
import { CATEGORIES, TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { addComment, approveRouting, submitTicket } from '../../src/db/services/ticketService.js';
import { withTransaction } from '../../src/db/transaction.js';
import { applyNotificationEvent, notificationSubscription } from '@smartdesk/notifications';
import { createTestPrisma, expectViolation, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('durable service outbox (integration)', () => {
  const prisma = createTestPrisma();
  const consumer = notificationSubscription.name;
  const claim = (now?: Date) => claimServiceEvent(prisma, notificationSubscription, now);
  const events = (ticketId: string) =>
    prisma.serviceOutboxEvent.findMany({ where: { aggregateId: ticketId } });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  const submit = (idempotencyKey = randomUUID()) =>
    submitTicket(prisma, {
      requesterId: USERS.erin,
      title: 'Outbox test ticket',
      description: 'Ticket content is private',
      idempotencyKey,
      correlationId: 'arbitrary request header text',
    });

  async function replyPair() {
    const { ticket } = await submit();
    const first = await addComment(prisma, {
      ticketId: ticket.id,
      authorId: USERS.admin,
      body: 'First reply content',
    });
    const second = await addComment(prisma, {
      ticketId: ticket.id,
      authorId: USERS.admin,
      body: 'Second reply content',
    });
    const replies = (await events(ticket.id)).filter(
      (event) => event.type === 'ticket.public-reply',
    );
    const older = replies.find(
      (event) => (event.payload as { commentId: string }).commentId === first.id,
    )!;
    const newer = replies.find(
      (event) => (event.payload as { commentId: string }).commentId === second.id,
    )!;
    return { older, newer };
  }

  it('publishes the created, routed and status facts once with a safe request correlation', async () => {
    const key = randomUUID();
    const { ticket } = await submit(key);
    expect((await submit(key)).created).toBe(false);
    const routed = await approveRouting(prisma, {
      ticketId: ticket.id,
      actorId: USERS.admin,
      categoryId: CATEGORIES.network,
      priority: 'HIGH',
      teamId: TEAMS.network,
      correlationId: 'routing request',
    });
    await addComment(prisma, {
      ticketId: ticket.id,
      authorId: USERS.admin,
      body: 'Private internal note',
      isInternal: true,
    });
    const rows = (await events(ticket.id)).map((row) =>
      serviceEventV1Schema.parse({ ...row, occurredAt: row.occurredAt.toISOString() }),
    );
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ticket.created',
          aggregateVersion: ticket.version,
          correlationId: hashCorrelationId('arbitrary request header text'),
          payload: {},
        }),
        expect.objectContaining({
          type: 'ticket.routed',
          aggregateVersion: routed.version,
          correlationId: hashCorrelationId('routing request'),
          payload: {
            previousTeamId: null,
            teamId: TEAMS.network,
            notification: { recipientId: USERS.erin, type: 'TICKET_ASSIGNED' },
          },
        }),
        expect.objectContaining({
          type: 'ticket.status-changed',
          aggregateVersion: routed.version,
          correlationId: hashCorrelationId('routing request'),
          payload: {
            previousStatus: 'OPEN',
            status: 'TRIAGED',
            notification: { recipientId: USERS.erin, type: 'TICKET_STATUS_CHANGED' },
          },
        }),
      ]),
    );
    expect(JSON.stringify(rows)).not.toMatch(
      /Private internal note|Ticket content|arbitrary request/,
    );
  });

  it('rolls ticket, audit and outbox back together and protects committed event history', async () => {
    const id = randomUUID();
    await expect(
      withTransaction(prisma, async (tx) => {
        await tx.ticket.create({
          data: { id, requesterId: USERS.erin, title: 'Rollback', description: 'Rollback' },
        });
        await appendEvent(tx, { ticketId: id, actorId: USERS.erin, type: 'CREATED' });
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow();
    expect(await prisma.ticket.count({ where: { id } })).toBe(0);
    expect(await prisma.ticketEvent.count({ where: { ticketId: id } })).toBe(0);
    expect(await events(id)).toEqual([]);
    const { ticket } = await submit();
    await expectViolation(
      prisma.serviceOutboxEvent.deleteMany({ where: { aggregateId: ticket.id } }),
      'append-only',
    );
  });

  it('catches up after consumer downtime and applies replies out of order without duplicating the inbox', async () => {
    const { older, newer } = await replyPair();
    expect(older.aggregateVersion).toBe(newer.aggregateVersion);
    expect(await prisma.serviceOutboxDelivery.count()).toBe(0);
    // Simulate a missing effect for the older fact and an already-read notice for the newer one.
    await prisma.notification.deleteMany({ where: { eventId: older.eventId } });
    const readAt = new Date();
    await prisma.notification.updateMany({ where: { eventId: newer.eventId }, data: { readAt } });

    const first = (await claim())!;
    const second = (await claim())!;
    const claims = [first, second];
    expect(claims.map((row) => row.eventId).sort()).toEqual([older.eventId, newer.eventId].sort());
    const late = claims.find((row) => row.eventId === older.eventId)!;
    const early = claims.find((row) => row.eventId === newer.eventId)!;
    expect(await deliverServiceEvent(prisma, early, applyNotificationEvent)).toBe('COMPLETED');
    expect(await deliverServiceEvent(prisma, late, applyNotificationEvent)).toBe('COMPLETED');
    expect(await deliverServiceEvent(prisma, early, applyNotificationEvent)).toBe('LOST');
    expect(await replayServiceEvent(prisma, consumer, early.eventId)).toBe(false);
    expect(await claim()).toBeNull();
    const notices = await prisma.notification.findMany({
      where: { eventId: { in: [older.eventId, newer.eventId] } },
    });
    expect(notices).toHaveLength(2);
    expect(notices.find((row) => row.eventId === newer.eventId)?.readAt).toEqual(readAt);
    expect(notices.find((row) => row.eventId === older.eventId)?.readAt).toBeNull();
  });

  it('rolls back a failed effect, waits for backoff, fences stale workers and replays a dead letter', async () => {
    const { older, newer } = await replyPair();
    const initialClaim = (await claim())!;
    const { eventId } = initialClaim;
    const abandoned = (await claim())!;
    const start = Date.now();
    const at = (ms: number) => new Date(start + ms);
    expect([older.eventId, newer.eventId]).toContain(eventId);
    await prisma.notification.deleteMany({ where: { eventId } });
    const fail = async (...args: Parameters<typeof applyNotificationEvent>) => {
      await applyNotificationEvent(...args);
      throw new Error('Private stack trace');
    };
    expect(await deliverServiceEvent(prisma, initialClaim, fail, at(0))).toBe('QUEUED');
    expect(await prisma.notification.count({ where: { eventId } })).toBe(0);
    expect(await claim(at(4999))).toBeNull();

    for (const [index, offset] of [5000, 15_000, 35_000, 75_000].entries()) {
      const retry = (await claim(at(offset)))!;
      expect(retry).toMatchObject({ eventId, attempts: index + 2 });
      expect(await deliverServiceEvent(prisma, retry, fail, at(offset))).toBe(
        index === 3 ? 'FAILED' : 'QUEUED',
      );
      if (offset === 15_000) {
        const reclaimAt = at(30_001);
        const reclaimed = (await claim(reclaimAt))!;
        expect(reclaimed.eventId).toBe(abandoned.eventId);
        expect(
          await deliverServiceEvent(prisma, abandoned, applyNotificationEvent, reclaimAt),
        ).toBe('LOST');
        expect(
          await deliverServiceEvent(prisma, reclaimed, applyNotificationEvent, reclaimAt),
        ).toBe('COMPLETED');
      }
    }
    expect(await claim(at(75_000))).toBeNull();
    expect(
      await prisma.serviceOutboxDelivery.findUnique({
        where: { consumer_eventId: { consumer, eventId } },
      }),
    ).toMatchObject({ state: 'FAILED', attempts: 5, errorKind: 'handler_failed' });
    expect(await replayServiceEvent(prisma, consumer, eventId)).toBe(true);
    const replay = (await claim(at(76_000)))!;
    expect(replay).toMatchObject({ eventId, attempts: 1 });
    expect(await deliverServiceEvent(prisma, replay, applyNotificationEvent, at(76_000))).toBe(
      'COMPLETED',
    );
    expect(await prisma.notification.count({ where: { eventId } })).toBe(1);
  });

  it('quarantines an unsupported envelope without invoking the v1 handler', async () => {
    const { ticket } = await submit();
    const eventId = randomUUID();
    await prisma.serviceOutboxEvent.create({
      data: {
        eventId,
        schemaVersion: 2,
        type: 'ticket.public-reply',
        occurredAt: new Date(),
        aggregateId: ticket.id,
        aggregateVersion: ticket.version,
        correlationId: eventId,
        payload: {},
      },
    });
    const delivery = (await claim())!;
    expect(delivery.eventId).toBe(eventId);
    expect(
      await deliverServiceEvent(prisma, delivery, async () => {
        throw new Error('Unexpected v2 delivery to v1 handler');
      }),
    ).toBe('FAILED');
    expect(await prisma.serviceOutboxDelivery.findFirst()).toMatchObject({
      eventId,
      state: 'FAILED',
      attempts: 1,
      errorKind: 'invalid_event',
    });
  });
});
