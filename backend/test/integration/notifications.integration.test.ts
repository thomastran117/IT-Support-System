import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CATEGORIES, TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { appendEvent } from '../../src/db/repositories/ticketEvents.js';
import { recordNotification } from '../../src/db/repositories/notifications.js';
import {
  addComment,
  approveRouting,
  transitionTicket,
} from '../../src/db/services/ticketService.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const SECRET = 'INTERNAL-ONLY-secret-note';

describe.skipIf(!testDatabaseUrl)('notification records and triggers (integration)', () => {
  const prisma = createTestPrisma();

  /** A ticket of Erin's in the network team, in progress and ready to be worked. */
  const make = (over: Record<string, unknown> = {}) =>
    prisma.ticket.create({
      data: {
        requesterId: USERS.erin,
        title: 'Notify target',
        description: 'd',
        status: 'IN_PROGRESS',
        categoryId: CATEGORIES.network,
        priority: 'HIGH',
        assignedTeamId: TEAMS.network,
        assigneeId: USERS.tara,
        ...over,
      },
    });
  const notices = () => prisma.notification.findMany({ orderBy: { createdAt: 'asc' } });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('turns one committed resolution into exactly one notice for the requester', async () => {
    const t = await make();
    await transitionTicket(prisma, {
      ticketId: t.id,
      actorId: USERS.tara,
      to: 'RESOLVED',
      resolutionSummary: 'Replaced the cable',
    });
    const rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientId: USERS.erin,
      ticketId: t.id,
      type: 'TICKET_RESOLVED',
      readAt: null,
    });
    const event = await prisma.ticketEvent.findFirstOrThrow({
      where: { ticketId: t.id, eventType: 'RESOLVED' },
    });
    expect(rows[0]!.eventId).toBe(event.id);
  });

  it('notifies for team assignment, status changes, public replies, resolution and staff reopen', async () => {
    const t = await make({ status: 'OPEN', assigneeId: null, assignedTeamId: null });
    // Routing to a team assigns it and auto-triages the ticket (OPEN -> TRIAGED).
    await approveRouting(prisma, {
      ticketId: t.id,
      actorId: USERS.admin,
      teamId: TEAMS.network,
      assigneeId: USERS.tara,
    });
    await transitionTicket(prisma, { ticketId: t.id, actorId: USERS.tara, to: 'IN_PROGRESS' });
    await addComment(prisma, { ticketId: t.id, authorId: USERS.tara, body: 'Looking now' });
    await transitionTicket(prisma, {
      ticketId: t.id,
      actorId: USERS.tara,
      to: 'RESOLVED',
      resolutionSummary: 'Done',
    });
    await transitionTicket(prisma, { ticketId: t.id, actorId: USERS.tara, to: 'OPEN' });
    expect((await notices()).map((n) => n.type).sort()).toEqual(
      [
        'TICKET_ASSIGNED',
        'TICKET_STATUS_CHANGED', // auto-triage
        'TICKET_STATUS_CHANGED', // IN_PROGRESS
        'TECHNICIAN_REPLY',
        'TICKET_RESOLVED',
        'TICKET_REOPENED',
      ].sort(),
    );
  });

  it('does not notify the requester about their own actions', async () => {
    const t = await make({
      status: 'RESOLVED',
      resolvedAt: new Date(Date.now() + 1000),
      resolutionSummary: 'Fixed',
    });
    await addComment(prisma, { ticketId: t.id, authorId: USERS.erin, body: 'Still broken' });
    await transitionTicket(prisma, { ticketId: t.id, actorId: USERS.erin, to: 'OPEN' });
    expect(await notices()).toHaveLength(0);
  });

  it('never notifies for internal notes, and never stores comment text', async () => {
    const t = await make();
    await addComment(prisma, {
      ticketId: t.id,
      authorId: USERS.tara,
      body: SECRET,
      isInternal: true,
    });
    expect(await notices()).toHaveLength(0);
    // A public reply still notifies, but the row carries no text at all.
    await addComment(prisma, { ticketId: t.id, authorId: USERS.tara, body: 'Public update' });
    const rows = await notices();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain('Public update');
  });

  it('does not notify for staff-only events', async () => {
    const t = await make({ status: 'OPEN', priority: 'UNSET', categoryId: null });
    for (const type of [
      'CREATED',
      'PRIORITY_UPDATED',
      'CATEGORY_UPDATED',
      'ASSIGNEE_UPDATED',
      'AI_REVIEWED',
    ] as const) {
      await appendEvent(prisma, { ticketId: t.id, actorId: USERS.tara, type });
    }
    expect(await notices()).toHaveLength(0);
  });

  it('treats a comment event with a missing internal flag as private', async () => {
    const t = await make();
    await appendEvent(prisma, { ticketId: t.id, actorId: USERS.tara, type: 'COMMENT_ADDED' });
    expect(await notices()).toHaveLength(0);
  });

  it('skips a deactivated requester', async () => {
    const t = await make({ requesterId: USERS.ivan });
    await transitionTicket(prisma, {
      ticketId: t.id,
      actorId: USERS.tara,
      to: 'RESOLVED',
      resolutionSummary: 'Done',
    });
    expect(await notices()).toHaveLength(0);
  });

  it('creates only one visible notice when the same event is recorded twice', async () => {
    const t = await make();
    const eventId = await appendEvent(prisma, {
      ticketId: t.id,
      actorId: USERS.tara,
      type: 'RESOLVED',
      details: { from: 'IN_PROGRESS' },
    });
    expect(await notices()).toHaveLength(1);
    const again = await recordNotification(prisma, {
      eventId,
      ticketId: t.id,
      actorId: USERS.tara,
      type: 'TICKET_RESOLVED',
    });
    expect(again).toBe(false);
    expect(await notices()).toHaveLength(1);
  });

  it('rejects a duplicate (recipient, event, type) at the database level', async () => {
    const t = await make();
    await appendEvent(prisma, { ticketId: t.id, actorId: USERS.tara, type: 'RESOLVED' });
    const [n] = await notices();
    await expect(
      prisma.notification.create({
        data: {
          recipientId: n!.recipientId,
          ticketId: n!.ticketId,
          eventId: n!.eventId,
          type: n!.type,
        },
      }),
    ).rejects.toBeTruthy();
  });

  it('leaves no event and no notification when the ticket mutation fails', async () => {
    const t = await make();
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    const events = await prisma.ticketEvent.count();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_notification() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER trg_fail_notification BEFORE INSERT ON notifications
       FOR EACH ROW EXECUTE FUNCTION fail_notification()`,
    );
    try {
      await expect(
        transitionTicket(prisma, {
          ticketId: t.id,
          actorId: USERS.tara,
          to: 'RESOLVED',
          resolutionSummary: 'Done',
        }),
      ).rejects.toBeTruthy();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER trg_fail_notification ON notifications');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_notification()');
    }
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toEqual(before);
    expect(await prisma.ticketEvent.count()).toBe(events);
    expect(await notices()).toHaveLength(0);
  });
});
