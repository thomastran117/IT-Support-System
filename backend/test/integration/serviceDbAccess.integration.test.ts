import { randomUUID } from 'node:crypto';
import { createPrisma, type PrismaClient } from '@smartdesk/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainNotificationEvents, listInbox, markRead } from '@smartdesk/notifications';
import {
  getTicketAudit,
  listEmployeeTickets,
  listTeamQueue,
  listUnassignedBacklog,
} from '../../src/db/repositories/operationalQueries.js';
import {
  reportAiAcceptance,
  reportAiAcceptanceByModel,
  reportAiAccuracy,
  reportAiAccuracyByModel,
  reportAiConfusion,
  reportDailyIntake,
  reportFirstResponse,
  reportRecurringCategories,
  reportResolutionTime,
  reportRoutingTime,
} from '../../src/db/repositories/reports.js';
import {
  claimSearchIndexJobs,
  completeSearchIndexJob,
  enqueueSearchIndexJob,
} from '../../src/db/repositories/searchIndexJobs.js';
import {
  ARTICLES,
  CATEGORIES,
  EMPTY_WINDOW,
  RECOMMENDATIONS,
  REPORT_WINDOW,
  TEAMS,
  TICKETS,
  USERS,
} from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import {
  approveRouting,
  reviewRecommendation,
  submitTicket,
} from '../../src/db/services/ticketService.js';
import { loadSql } from '../../src/db/sql.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const serviceNames = [
  'ticket',
  'notifications',
  'knowledge',
  'identity',
  'analytics',
  'search',
] as const;
type Service = (typeof serviceNames)[number];

const windowOf = (period: { start: string; end: string }) => ({
  start: new Date(period.start),
  end: new Date(period.end),
});

const readReports = (db: PrismaClient, period: { start: string; end: string } = REPORT_WINDOW) =>
  Promise.all(
    [
      reportRoutingTime,
      reportResolutionTime,
      reportAiAccuracy,
      reportAiAcceptance,
      reportRecurringCategories,
      reportDailyIntake,
      reportFirstResponse,
      reportAiAccuracyByModel,
      reportAiAcceptanceByModel,
      reportAiConfusion,
    ].map((report) => report(db, USERS.admin, windowOf(period))),
  );

const readOperations = (db: PrismaClient) =>
  Promise.all([
    listEmployeeTickets(db, USERS.erin),
    listTeamQueue(db, USERS.tara, TEAMS.network),
    listUnassignedBacklog(db, USERS.tara),
    getTicketAudit(db, USERS.tara, TICKETS.vpn),
  ]);

const permissionDenied = (operation: Promise<unknown>) =>
  expect(operation).rejects.toMatchObject({
    meta: { driverAdapterError: { cause: { originalCode: '42501' } } },
  });

describe.skipIf(!testDatabaseUrl)('service-owned PostgreSQL privileges', () => {
  const owner = createTestPrisma();
  const logins: { name: string; db: PrismaClient }[] = [];
  const service = {} as Record<Service, PrismaClient>;
  const apply = (name: 'roles' | 'enable' | 'disable') =>
    owner.$executeRawUnsafe(loadSql(`service-access/${name}.sql`));

  async function connect(group: Service | 'legacy_search') {
    const name = `sd091_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    // Identifiers and passwords here are either fixed group names or UUIDs generated for the test.
    await owner.$executeRawUnsafe(`DO $login$ BEGIN
      CREATE ROLE "${name}" LOGIN PASSWORD '${password}';
      GRANT smartdesk_${group} TO "${name}" WITH INHERIT TRUE, SET FALSE;
    END $login$;`);
    const url = new URL(testDatabaseUrl!);
    url.username = name;
    url.password = password;
    const db = createPrisma(url.toString());
    logins.push({ name, db });
    return { name, db };
  }

  beforeAll(async () => {
    await seedDatabase(owner, { profile: 'test', reset: true, databaseUrl: testDatabaseUrl! });
    const before = await readReports(owner);
    await apply('roles');
    await apply('roles');
    await owner.$executeRaw`GRANT SELECT (description) ON public.tickets TO PUBLIC`;
    try {
      await expect(apply('enable')).rejects.toThrow(/Remove PUBLIC/);
    } finally {
      await owner.$executeRaw`REVOKE SELECT (description) ON public.tickets FROM PUBLIC`;
    }
    await apply('enable');
    await apply('enable');
    expect(await readReports(owner)).toEqual(before);

    for (const name of serviceNames) service[name] = (await connect(name)).db;
  });

  afterAll(async () => {
    try {
      await apply('disable');
      for (const { name, db } of logins) {
        await db.$disconnect();
        await owner.$executeRawUnsafe(`DROP ROLE "${name}"`);
      }
      await resetDatabase(owner);
    } finally {
      await owner.$disconnect();
    }
  });

  it('runs existing operational and reporting queries through dedicated logins', async () => {
    const [history, queue, backlog, audit] = await readOperations(owner);
    expect(await readOperations(service.ticket)).toEqual([
      history,
      queue.map((ticket) => ({ ...ticket, ageMinutes: expect.any(Number) })),
      backlog.map((ticket) => ({ ...ticket, ageMinutes: expect.any(Number) })),
      audit,
    ]);
    expect(await readReports(service.analytics)).toEqual(await readReports(owner));
    expect(await readReports(service.analytics, EMPTY_WINDOW)).toEqual(
      await readReports(owner, EMPTY_WINDOW),
    );
    await expect(
      reportRoutingTime(service.analytics, USERS.erin, windowOf(REPORT_WINDOW)),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('denies cross-owner writes, private fields, DDL and permission switching', async () => {
    const statements: [Service, string][] = [
      ['ticket', 'UPDATE users SET is_active = false WHERE false'],
      ['ticket', 'UPDATE notifications SET read_at = now() WHERE false'],
      ['ticket', 'UPDATE ai_recommendations SET suggestion = NULL WHERE false'],
      ['ticket', 'DELETE FROM ticket_events WHERE false'],
      ['ticket', 'SET ROLE smartdesk_identity'],
      ['ticket', 'CREATE TABLE public.sd091_unexpected (id integer)'],
      ['notifications', "UPDATE tickets SET title = 'other owner' WHERE false"],
      ['notifications', 'UPDATE notifications SET recipient_id = gen_random_uuid() WHERE false'],
      ['knowledge', "UPDATE ticket_categories SET name = 'other owner' WHERE false"],
      ['identity', "UPDATE tickets SET title = 'other owner' WHERE false"],
      ['analytics', 'DELETE FROM classification_labels WHERE false'],
      ['search', "UPDATE knowledge_articles SET title = 'other owner' WHERE false"],
      ['search', 'UPDATE search_index_jobs SET revision = 5 WHERE false'],
    ];
    for (const [name, statement] of statements) {
      await permissionDenied(service[name].$executeRawUnsafe(statement));
    }
    await permissionDenied(service.ticket.$queryRaw`SELECT password_hash FROM users`);
    await permissionDenied(service.analytics.$queryRaw`SELECT description FROM tickets`);
    await permissionDenied(service.analytics.$queryRaw`SELECT body FROM ticket_comments`);
    await permissionDenied(service.search.$queryRaw`SELECT body FROM knowledge_articles`);
    await permissionDenied(service.ticket.$queryRaw`SELECT migration_name FROM _prisma_migrations`);
    await permissionDenied(
      service.ticket.$queryRaw`SELECT setval('search_index_jobs_sequence_seq', 1)`,
    );
    expect(
      await service.identity.$queryRaw`SELECT count(password_hash) AS count FROM users`,
    ).toEqual([{ count: 8n }]);
  });

  it('keeps Ticket submission, leases, routing and human review in the existing transactions', async () => {
    const input = {
      requesterId: USERS.erin,
      title: 'Scoped role submission',
      description: 'A synthetic ticket created through the Ticket login.',
      idempotencyKey: 'sd091-role-test',
      enqueueAnalysis: { maxAttempts: 3 },
    };
    const created = await submitTicket(service.ticket, input);
    expect(created.created).toBe(true);
    expect(await submitTicket(service.ticket, input)).toMatchObject({
      created: false,
      ticket: { id: created.ticket.id },
    });
    expect(await owner.ticketEvent.count({ where: { ticketId: created.ticket.id } })).toBe(1);
    expect(
      await owner.serviceOutboxEvent.count({ where: { aggregateId: created.ticket.id } }),
    ).toBe(1);
    await permissionDenied(service.ticket.$queryRaw`SELECT event_id FROM service_outbox_events`);
    const first = await owner.serviceOutboxEvent.findFirstOrThrow({
      where: { aggregateId: created.ticket.id, type: 'ticket.created' },
    });
    await owner.serviceOutboxDelivery.create({
      data: { consumer: 'another-consumer', eventId: first.eventId },
    });
    expect(
      await service.notifications.serviceOutboxEvent.findUnique({
        where: { eventId: first.eventId },
      }),
    ).toBeNull();
    expect(
      await service.notifications.serviceOutboxDelivery.findMany({
        where: { consumer: 'another-consumer' },
      }),
    ).toEqual([]);
    await permissionDenied(service.notifications.$executeRaw`
      INSERT INTO service_outbox_deliveries (consumer, event_id)
      VALUES ('forged-consumer', ${first.eventId}::uuid)`);
    expect(await owner.aiAnalysisJob.count({ where: { ticketId: created.ticket.id } })).toBe(1);
    expect(await owner.searchIndexJob.count({ where: { entityId: created.ticket.id } })).toBe(1);

    const routed = await approveRouting(service.ticket, {
      ticketId: created.ticket.id,
      actorId: USERS.tara,
      expectedVersion: created.ticket.version,
      categoryId: CATEGORIES.hardware,
      teamId: TEAMS.network,
      priority: 'MEDIUM',
      outboxNotifications: true,
    });
    expect(routed.status).toBe('TRIAGED');
    expect(await owner.notification.count({ where: { ticketId: created.ticket.id } })).toBe(0);
    expect(await drainNotificationEvents(service.notifications)).toMatchObject({
      COMPLETED: 2,
      FAILED: 0,
    });
    const inbox = await listInbox(service.notifications, USERS.erin, {
      unreadOnly: true,
      limit: 20,
      offset: 0,
    });
    const assignment = inbox.find(
      (notice) => notice.ticketId === created.ticket.id && notice.type === 'TICKET_ASSIGNED',
    );
    expect(assignment).toMatchObject({ ticketTitle: input.title, readAt: null });
    expect(await markRead(service.notifications, USERS.erin, assignment!.id)).toBe(true);
    expect(await drainNotificationEvents(service.notifications)).toMatchObject({ COMPLETED: 0 });
    expect(await owner.notification.findUnique({ where: { id: assignment!.id } })).toMatchObject({
      readAt: expect.any(Date),
    });

    const recommendationId = RECOMMENDATIONS.vpnReanalysis;
    const ticket = await owner.ticket.findUniqueOrThrow({ where: { id: TICKETS.vpn } });
    const proposal = await owner.aiRecommendation.findUniqueOrThrow({
      where: { id: recommendationId },
    });
    const review = await reviewRecommendation(service.ticket, {
      reviewerId: USERS.tara,
      recommendationId,
      decision: 'ACCEPTED',
      expectedVersion: ticket.version,
    });
    expect(review.ticket).toMatchObject({
      categoryId: proposal.proposedCategoryId,
      priority: proposal.proposedPriority,
      version: ticket.version + 1,
    });
    expect(
      await owner.aiRecommendation.findUniqueOrThrow({ where: { id: recommendationId } }),
    ).toMatchObject({
      reviewStatus: 'ACCEPTED',
      proposedCategoryId: proposal.proposedCategoryId,
      suggestion: proposal.suggestion,
    });
    expect(
      await owner.ticketEvent.count({ where: { ticketId: ticket.id, eventType: 'AI_REVIEWED' } }),
    ).toBe(2);
  });

  it('isolates outbox producers and lets the search consumer settle jobs and read safe projections', async () => {
    const entityId = randomUUID();
    const ticketJob = { entityType: 'TICKET', entityId, revision: 1, eventKind: 'UPSERT' } as const;
    const articleJob = { ...ticketJob, entityType: 'KNOWLEDGE_ARTICLE' } as const;
    const enqueue = (db: PrismaClient, job: typeof ticketJob | typeof articleJob) =>
      db.$transaction((tx) => enqueueSearchIndexJob(tx, job));

    expect(await enqueue(service.ticket, ticketJob)).toBe(1);
    expect(await enqueue(service.knowledge, articleJob)).toBe(1);
    expect(await enqueue(service.ticket, ticketJob)).toBe(0);
    await permissionDenied(enqueue(service.ticket, { ...articleJob, revision: 2 }));
    await permissionDenied(enqueue(service.knowledge, { ...ticketJob, revision: 2 }));
    expect(
      await service.ticket
        .$queryRaw`SELECT entity_type FROM search_index_jobs WHERE entity_id = ${entityId}::uuid`,
    ).toEqual([{ entity_type: 'TICKET' }]);
    expect(
      await service.knowledge
        .$queryRaw`SELECT entity_type FROM search_index_jobs WHERE entity_id = ${entityId}::uuid`,
    ).toEqual([{ entity_type: 'KNOWLEDGE_ARTICLE' }]);
    const { name, db: legacy } = await connect('legacy_search');
    try {
      await permissionDenied(legacy.$queryRaw`SELECT entity_type FROM search_index_jobs`);
      await owner.$executeRawUnsafe(
        `GRANT SELECT (entity_type) ON public.search_index_jobs TO "${name}"`,
      );
      expect(
        await legacy.$queryRaw`SELECT DISTINCT entity_type FROM search_index_jobs ORDER BY entity_type`,
      ).toEqual([{ entity_type: 'KNOWLEDGE_ARTICLE' }, { entity_type: 'TICKET' }]);
    } finally {
      await owner.$executeRawUnsafe(
        `REVOKE SELECT (entity_type) ON public.search_index_jobs FROM "${name}"`,
      );
    }
    const claims = await claimSearchIndexJobs(service.search, { limit: 100, leaseMs: 30000 });
    const claim = claims.find(
      (entry) => entry.entityId === entityId && entry.entityType === 'TICKET',
    );
    expect(claim).toBeDefined();
    expect(await completeSearchIndexJob(service.search, claim!)).toBe(1);
    const projection = await service.search.$queryRaw`
      SELECT is_published, body, search_revision FROM smartdesk_search_article_sources
      WHERE article_id = ${ARTICLES.draft}::uuid`;
    expect(projection).toEqual([{ is_published: false, body: null, search_revision: 1 }]);
  });

  it('rolls back access without changing source rows, report results or queue state', async () => {
    const snapshot = () => owner.$queryRaw`
      SELECT
        (SELECT jsonb_agg(t ORDER BY ticket_id) FROM tickets t) AS tickets,
        (SELECT jsonb_agg(r ORDER BY recommendation_id) FROM ai_recommendations r) AS recommendations,
        (SELECT jsonb_agg(e ORDER BY event_id) FROM ticket_events e) AS audit,
        (SELECT jsonb_agg(n ORDER BY notification_id) FROM notifications n) AS inbox,
        (SELECT jsonb_agg(j ORDER BY job_id) FROM ai_analysis_jobs j) AS leases,
        (SELECT jsonb_agg(s ORDER BY sequence) FROM search_index_jobs s) AS outbox`;
    const before = await snapshot();
    const reports = await readReports(owner);
    try {
      await apply('disable');
      await apply('disable');
      await permissionDenied(service.analytics.$queryRaw`SELECT ticket_id FROM tickets`);
      await permissionDenied(service.ticket.$queryRaw`SELECT entity_type FROM search_index_jobs`);
      expect(await snapshot()).toEqual(before);
      expect(await readReports(owner)).toEqual(reports);
    } finally {
      await apply('enable');
    }
  });
});
