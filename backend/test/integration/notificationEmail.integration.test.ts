import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { claimNext, finish } from '../../src/db/repositories/notificationDeliveries.js';
import { addComment, transitionTicket } from '../../src/db/services/ticketService.js';
import {
  createEmailDispatcher,
  type DispatchLogEntry,
  type DispatcherConfig,
} from '../../src/modules/notifications/email/dispatcher.js';
import {
  EmailError,
  createSinkTransport,
  type SinkTransport,
} from '../../src/modules/notifications/email/transport.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);
const NOTE = 'INTERNAL-ONLY-secret-note';
const SUMMARY = 'RESOLUTION-SUMMARY-text';
const TITLE = 'Printer on floor 3 is broken';
const SECOND = 1000;

describe.skipIf(!testDatabaseUrl)('notification email channel (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;
  let sink: SinkTransport;
  let clock: Date;
  let logs: DispatchLogEntry[];

  const config = (over: Partial<DispatcherConfig> = {}): DispatcherConfig => ({
    appBaseUrl: 'https://help.example.com',
    maxAttempts: 3,
    backoffBaseMs: 30 * SECOND,
    maxAgeMs: 24 * 3_600_000,
    pollIntervalMs: 1000,
    sendTimeoutMs: 2000,
    leaseMs: 60 * SECOND,
    ...over,
  });
  const dispatcher = (over: Partial<DispatcherConfig> = {}, transport = sink) =>
    createEmailDispatcher({
      prisma,
      transport,
      config: config(over),
      log: (e) => logs.push(e),
      now: () => clock,
    });
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  const makeTicket = (over: Record<string, unknown> = {}) =>
    prisma.ticket.create({
      data: {
        requesterId: USERS.erin,
        title: TITLE,
        description: 'd',
        status: 'IN_PROGRESS',
        categoryId: CATEGORIES.network,
        priority: 'HIGH',
        assignedTeamId: TEAMS.network,
        assigneeId: USERS.tara,
        ...over,
      },
    });
  const resolve = (ticketId: string) =>
    transitionTicket(prisma, {
      ticketId,
      actorId: USERS.tara,
      to: 'RESOLVED',
      resolutionSummary: SUMMARY,
    });
  const deliveries = () => prisma.notificationDelivery.findMany({ orderBy: { createdAt: 'asc' } });
  const erinEmail = async () =>
    (await prisma.user.findUniqueOrThrow({ where: { id: USERS.erin } })).email;

  beforeAll(async () => {
    app = await buildApp({ env, prisma, checkDb: async () => true, logger: false });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    sink = createSinkTransport();
    clock = new Date();
    logs = [];
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('sends one sanitized email for one event, and never again for the same notification', async () => {
    const t = await makeTicket();
    await addComment(prisma, {
      ticketId: t.id,
      authorId: USERS.tara,
      body: NOTE,
      isInternal: true,
    });
    await resolve(t.id);

    const d = dispatcher();
    expect(await d.tick()).toBe(1);
    expect(sink.sent).toHaveLength(1);
    const mail = sink.sent[0]!;
    expect(mail.to).toBe(await erinEmail());
    expect(mail.subject).toBe('[SmartDesk] Your ticket was resolved');
    expect(mail.text).toContain('Your ticket was resolved.');
    expect(mail.text).toContain(TITLE);
    expect(mail.text).toContain(`https://help.example.com/employee/tickets/${t.id}`);
    for (const body of [mail.text, mail.html, mail.subject]) {
      expect(body).not.toContain(NOTE);
      expect(body).not.toContain(SUMMARY);
    }
    expect((await deliveries())[0]).toMatchObject({ state: 'SENT', attempts: 1, errorKind: null });

    // Sweeping and ticking again, even much later, sends nothing new.
    advance(10 * 60_000);
    expect(await d.tick()).toBe(0);
    expect(await dispatcher().tick()).toBe(0);
    expect(sink.sent).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it('sends one email even when two workers run at the same time', async () => {
    await resolve((await makeTicket()).id);
    await Promise.all([dispatcher().tick(), dispatcher().tick(), dispatcher().tick()]);
    expect(sink.sent).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it('emails each notification once: a reply and a resolution give two emails', async () => {
    const t = await makeTicket();
    await addComment(prisma, { ticketId: t.id, authorId: USERS.tara, body: 'Looking now' });
    await resolve(t.id);
    await dispatcher().tick();
    expect(sink.sent.map((m) => m.subject).sort()).toEqual([
      '[SmartDesk] A technician replied to your ticket',
      '[SmartDesk] Your ticket was resolved',
    ]);
    expect(new Set(sink.sent.map((m) => m.messageId)).size).toBe(2);
    expect(JSON.stringify(sink.sent)).not.toContain('Looking now');
  });

  it('retries a temporary failure after the backoff without sending duplicates', async () => {
    await resolve((await makeTicket()).id);
    const d = dispatcher();
    sink.failWith = new EmailError('temporary', true);
    await d.tick();
    expect(sink.sent).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({
      state: 'QUEUED',
      attempts: 1,
      errorKind: 'temporary',
    });

    // Not due yet: nothing is attempted.
    sink.failWith = null;
    advance(10 * SECOND);
    expect(await d.tick()).toBe(0);
    expect(sink.sent).toHaveLength(0);

    advance(30 * SECOND);
    expect(await d.tick()).toBe(1);
    expect(sink.sent).toHaveLength(1);
    expect((await deliveries())[0]).toMatchObject({ state: 'SENT', attempts: 2 });

    advance(60 * 60_000);
    await d.tick();
    expect(sink.sent).toHaveLength(1);
  });

  it('gives up after the allowed attempts, with a reason code only', async () => {
    await resolve((await makeTicket()).id);
    const d = dispatcher({ maxAttempts: 2 });
    sink.failWith = new EmailError('unavailable', true);
    await d.tick();
    advance(60 * SECOND);
    await d.tick();
    advance(3600 * SECOND);
    await d.tick();
    expect(sink.sent).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({
      state: 'FAILED',
      attempts: 2,
      errorKind: 'unavailable',
    });
    expect((await deliveries())[0]!.completedAt).not.toBeNull();
  });

  it('does not retry a rejected login or recipient', async () => {
    await resolve((await makeTicket()).id);
    sink.failWith = new EmailError('auth_failed', false);
    await dispatcher().tick();
    expect((await deliveries())[0]).toMatchObject({
      state: 'FAILED',
      attempts: 1,
      errorKind: 'auth_failed',
    });
  });

  it('treats a hung server as a retryable timeout', async () => {
    await resolve((await makeTicket()).id);
    const hung = { send: () => new Promise<void>(() => {}) };
    await dispatcher({ sendTimeoutMs: 50 }, hung as unknown as SinkTransport).tick();
    expect((await deliveries())[0]).toMatchObject({
      state: 'QUEUED',
      attempts: 1,
      errorKind: 'unavailable',
    });
  });

  it('an email outage never touches the ticket or the in-app notification', async () => {
    const t = await makeTicket();
    sink.failWith = new EmailError('unavailable', true);
    await resolve(t.id);
    await dispatcher().tick();

    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(
      'RESOLVED',
    );
    expect(await prisma.notification.count({ where: { ticketId: t.id } })).toBe(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: USERS.erin } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: {
        authorization: `Bearer ${await tokens.sign('access', user.id, user.tokenVersion)}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ total: 1, unreadCount: 1 });
    expect(res.json().data.items[0]).toMatchObject({ type: 'TICKET_RESOLVED', read: false });
  });

  it('without an email dispatcher nothing is queued and the notice is still complete', async () => {
    const t = await makeTicket();
    await resolve(t.id);
    expect(await prisma.notificationDelivery.count()).toBe(0);
    expect(await prisma.notification.count({ where: { ticketId: t.id } })).toBe(1);
  });

  it('skips a notification the employee already read', async () => {
    await resolve((await makeTicket()).id);
    await prisma.notification.updateMany({ data: { readAt: new Date() } });
    await dispatcher().tick();
    expect(sink.sent).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ state: 'SKIPPED', errorKind: 'already_read' });
  });

  it('skips a recipient who was deactivated before the send', async () => {
    await resolve((await makeTicket()).id);
    await prisma.user.update({ where: { id: USERS.erin }, data: { isActive: false } });
    await dispatcher().tick();
    expect(sink.sent).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ state: 'SKIPPED', errorKind: 'no_recipient' });
  });

  it('never emails old history when email is switched on', async () => {
    await resolve((await makeTicket()).id);
    await prisma.$executeRawUnsafe(
      `UPDATE notifications SET created_at = now() - interval '3 days'`,
    );
    await dispatcher().tick();
    expect(sink.sent).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
  });

  it('expires a delivery that waited past the maximum age', async () => {
    await resolve((await makeTicket()).id);
    sink.failWith = new EmailError('unavailable', true);
    const d = dispatcher();
    await d.tick();
    sink.failWith = null;
    await prisma.$executeRawUnsafe(
      `UPDATE notification_deliveries SET created_at = now() - interval '2 days'`,
    );
    advance(3600 * SECOND);
    await d.tick();
    expect(sink.sent).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ state: 'SKIPPED', errorKind: 'expired' });
  });

  it('fences a stale worker: after its lease expires only the new holder can finish', async () => {
    await resolve((await makeTicket()).id);
    await dispatcher().tick(); // queues it (and sends)
    await prisma.$executeRawUnsafe(
      `UPDATE notification_deliveries SET state = 'QUEUED', completed_at = NULL, attempts = 0`,
    );
    const first = await claimNext(prisma, { leaseMs: 1000, now: clock });
    expect(first).not.toBeNull();
    advance(5 * SECOND);
    const second = await claimNext(prisma, { leaseMs: 60_000, now: clock });
    expect(second?.id).toBe(first!.id);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);

    expect(await finish(prisma, first!, { state: 'SENT' }, clock)).toBe(false);
    expect(await finish(prisma, second!, { state: 'SENT' }, clock)).toBe(true);
  });

  it('logs ids and reason codes only: no address, title, text or credential', async () => {
    const t = await makeTicket();
    await addComment(prisma, {
      ticketId: t.id,
      authorId: USERS.tara,
      body: NOTE,
      isInternal: true,
    });
    await resolve(t.id);
    const d = dispatcher();
    sink.failWith = new EmailError('rejected', false);
    await d.tick();
    await prisma.$executeRawUnsafe(
      `UPDATE notification_deliveries SET state='QUEUED', completed_at=NULL`,
    );
    sink.failWith = null;
    await d.tick();
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    for (const secret of [await erinEmail(), TITLE, NOTE, SUMMARY, 'help.example.com']) {
      expect(text).not.toContain(secret);
    }
  });

  it('a stopped dispatcher drains and stops', async () => {
    const d = dispatcher({ pollIntervalMs: 50 });
    d.start();
    await resolve((await makeTicket()).id);
    await new Promise((r) => setTimeout(r, 300));
    await d.stop();
    expect(sink.sent).toHaveLength(1);
  });
});
