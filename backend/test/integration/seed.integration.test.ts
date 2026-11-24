import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { DEMO_ANCHOR_TICKET, newDemoAnchor } from '../../src/db/seed/demoFixtures.js';
import {
  ARTICLES,
  buildFixtures,
  DEMO_PASSWORD,
  EXPECTED,
  TEAMS,
  TICKETS,
  USERS,
} from '../../src/db/seed/fixtures.js';
import { assertResettable, countRows, seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const demoNow = new Date('2026-11-24T17:00:00Z');

describe.skipIf(!testDatabaseUrl)('seed fixtures (integration)', () => {
  const prisma = createTestPrisma();
  const seed = (profile: 'demo' | 'test', reset = false, now = demoNow) =>
    seedDatabase(prisma, { profile, reset, now, databaseUrl: testDatabaseUrl! });

  beforeEach(() => resetDatabase(prisma));
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('populates every core table with the documented row counts (test profile)', async () => {
    const counts = await seed('test');
    expect(counts).toEqual(EXPECTED.rowCounts);
  });

  it('can be re-run without duplicating or modifying rows', async () => {
    const first = await seed('test');
    const [{ events }] = await prisma.$queryRaw<{ events: string }[]>`
      SELECT md5(string_agg(event_id::text || occurred_at::text, ',' ORDER BY event_id)) AS events
      FROM ticket_events`;
    const second = await seed('test');
    const third = await seed('test', true);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    const [{ events: after }] = await prisma.$queryRaw<{ events: string }[]>`
      SELECT md5(string_agg(event_id::text || occurred_at::text, ',' ORDER BY event_id)) AS events
      FROM ticket_events`;
    expect(after).toBe(events);
  });

  it('seeds the expanded demo and adds it to databases running the original demo', async () => {
    const counts = await seed('demo');
    expect(counts).toMatchObject({
      users: 40,
      support_teams: 7,
      team_members: 13,
      ticket_categories: 9,
      tickets: 300,
      ticket_comments: 360,
      ticket_events: 2227,
      knowledge_articles: 31,
      ai_recommendations: 102,
      recommendation_articles: 148,
      classification_labels: 149,
      notifications: 1007,
    });
    expect(await prisma.knowledgeArticle.count({ where: { isPublished: true } })).toBe(26);
    expect(await prisma.notificationDelivery.count()).toBe(0);
    expect(await prisma.aiAnalysisJob.count()).toBe(0);

    await resetDatabase(prisma);
    await seed('test');
    const legacy = buildFixtures('demo');
    await prisma.ticket.createMany({ data: legacy.tickets.slice(EXPECTED.rowCounts.tickets) });
    await prisma.ticketEvent.createMany({
      data: legacy.events.slice(EXPECTED.rowCounts.ticket_events),
    });
    await prisma.knowledgeArticle.createMany({
      data: legacy.articles.slice(EXPECTED.rowCounts.knowledge_articles),
    });
    const legacyTitle = 'Presenter’s meeting room example';
    await prisma.ticket.update({ where: { id: TICKETS.demoA }, data: { title: legacyTitle } });
    const legacyArticle = await prisma.knowledgeArticle.findUniqueOrThrow({
      where: { id: ARTICLES.demoWifi },
    });
    expect(await seed('demo')).toEqual(counts);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.demoA } })).toMatchObject({
      title: legacyTitle,
    });
    expect(
      await prisma.knowledgeArticle.findUniqueOrThrow({ where: { id: ARTICLES.demoWifi } }),
    ).toEqual(legacyArticle);
  });

  it('preserves the demo calendar, presenter changes, and inbox reads on a later rerun', async () => {
    const first = await seed('demo');
    const ticket = await prisma.ticket.update({
      where: { id: DEMO_ANCHOR_TICKET },
      data: { priority: 'HIGH', version: { increment: 1 } },
    });
    const unread = await prisma.notification.findFirstOrThrow({
      where: { recipientId: USERS.erin, readAt: null },
    });
    const later = new Date('2026-12-10T12:00:00Z');
    await prisma.notification.update({ where: { id: unread.id }, data: { readAt: later } });
    const snapshot = () =>
      prisma.ticketEvent.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, occurredAt: true },
      });
    const before = await snapshot();

    expect(await seed('demo', false, later)).toEqual(first);
    expect(await snapshot()).toEqual(before);
    expect(ticket.createdAt).toEqual(newDemoAnchor(demoNow));
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(ticket);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: unread.id } })).toMatchObject(
      { readAt: later },
    );
  });

  it('uses one calendar when concurrent first seeds cross UTC midnight', async () => {
    const tomorrow = new Date('2026-11-25T12:00:00Z');
    const [first, second] = await Promise.all([seed('demo'), seed('demo', false, tomorrow)]);
    expect(first).toEqual(second);
    expect(first.tickets).toBe(300);
    const anchor = await prisma.ticket.findUniqueOrThrow({ where: { id: DEMO_ANCHOR_TICKET } });
    expect([newDemoAnchor(demoNow), newDemoAnchor(tomorrow)]).toContainEqual(anchor.createdAt);
    expect(
      await prisma.ticketEvent.findFirstOrThrow({
        where: { ticketId: anchor.id, eventType: 'CREATED' },
      }),
    ).toMatchObject({ occurredAt: anchor.createdAt });
  });

  it('derives ticket states, first responses, and inbox items from coherent demo timelines', async () => {
    await seed('demo');
    const tickets = await prisma.ticket.findMany({
      where: { id: { gte: DEMO_ANCHOR_TICKET } },
      include: {
        events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
        comments: { orderBy: { createdAt: 'asc' } },
        notifications: true,
      },
    });
    const totals: Record<string, number> = {};
    for (const ticket of tickets) {
      const { events, comments, notifications } = ticket;
      expect(events[0]).toMatchObject({ eventType: 'CREATED', occurredAt: ticket.createdAt });
      expect(events.at(-1)!.occurredAt.getTime()).toBeLessThan(demoNow.getTime());
      const lastStatus = [...events]
        .reverse()
        .find(({ eventType }) => ['STATUS_CHANGED', 'RESOLVED', 'REOPENED'].includes(eventType));
      const status =
        lastStatus?.eventType === 'STATUS_CHANGED'
          ? (lastStatus.details as { to: string }).to
          : lastStatus?.eventType === 'RESOLVED'
            ? 'RESOLVED'
            : 'OPEN';
      expect(ticket.status).toBe(status);
      const kind = lastStatus?.eventType === 'REOPENED' ? 'REOPENED' : status;
      totals[kind] = (totals[kind] ?? 0) + 1;

      const firstReply = comments.find(
        (comment) => !comment.isInternal && comment.authorId !== ticket.requesterId,
      );
      expect(ticket.firstResponseAt).toEqual(firstReply?.createdAt ?? null);
      for (const notice of notifications) {
        const event = events.find(({ id }) => id === notice.eventId);
        expect(event).toBeDefined();
        expect(event!.actorId).not.toBe(ticket.requesterId);
        expect(notice.recipientId).toBe(ticket.requesterId);
        expect(notice.createdAt).toEqual(event!.occurredAt);
        if (notice.type === 'TECHNICIAN_REPLY')
          expect(event!.details).toMatchObject({ isInternal: false });
      }
    }
    expect(totals).toEqual({
      OPEN: 60,
      REOPENED: 12,
      TRIAGED: 48,
      IN_PROGRESS: 72,
      RESOLVED: 60,
      CLOSED: 36,
    });
  });

  it('supports the employee, technician, and admin walkthrough via their demo logins', async () => {
    await seed('demo');
    const app = await buildApp({
      env: loadEnv({ FRONTEND_ORIGIN: 'http://app.test' }),
      prisma,
      logger: false,
      checkDb: async () => true,
      checkCache: async () => 'disabled',
    });
    const login = async (name: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `${name}@smartdesk.test`, password: DEMO_PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      return { authorization: `Bearer ${response.json().data.accessToken}` };
    };
    const get = async (headers: Awaited<ReturnType<typeof login>>, url: string) => {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode, url).toBe(200);
      return response.json().data;
    };

    try {
      const erin = await login('erin');
      const tara = await login('tara');
      const admin = await login('admin');
      const history = await get(erin, '/api/tickets?limit=10');
      expect(history.nextOffset).toBe(10);
      expect(history.items).toContainEqual(expect.objectContaining({ id: DEMO_ANCHOR_TICKET }));
      const inbox = await get(erin, '/api/notifications?limit=10');
      expect(inbox.nextOffset).toBe(10);
      expect(inbox.unreadCount).toBeGreaterThan(0);
      expect(inbox.unreadCount).toBeLessThan(inbox.total);
      expect(await get(erin, '/api/knowledge?limit=10')).toMatchObject({
        total: 26,
        nextOffset: 10,
      });

      const withNote = await prisma.ticket.findFirstOrThrow({
        where: {
          id: { gte: DEMO_ANCHOR_TICKET },
          requesterId: USERS.erin,
          assignedTeamId: TEAMS.network,
          comments: { some: { isInternal: true } },
        },
      });
      const commentsPath = `/api/tickets/${withNote.id}/comments`;
      expect(await get(tara, commentsPath)).toContainEqual(
        expect.objectContaining({ isInternal: true }),
      );
      expect(await get(erin, commentsPath)).not.toContainEqual(
        expect.objectContaining({ isInternal: true }),
      );

      expect(await get(tara, '/api/technician/unassigned?limit=10')).toMatchObject({
        nextOffset: 10,
      });
      const queue = `/api/technician/queue?teamId=${TEAMS.network}&limit=10`;
      expect(await get(tara, queue)).toMatchObject({ nextOffset: 10 });
      expect(await get(tara, `${queue}&mine=true`)).toMatchObject({ nextOffset: 10 });
      const recommendationPath = `/api/tickets/${DEMO_ANCHOR_TICKET}/recommendations`;
      const [recommendation] = await get(tara, recommendationPath);
      expect(recommendation).toMatchObject({
        review: { status: 'PENDING' },
        articles: expect.arrayContaining([
          expect.objectContaining({ title: 'Troubleshoot VPN disconnects after sleep' }),
        ]),
      });

      const search = await get(admin, '/api/tickets/search?q=VPN&limit=10');
      expect(search.items).toHaveLength(10);
      expect(search.nextCursor).toBeTruthy();
      expect(await get(admin, '/api/admin/knowledge?published=false')).toMatchObject({ total: 5 });
      const window = 'start=2026-10-26&end=2026-11-25';
      const reports = await get(admin, `/api/admin/reports/summary?${window}`);
      expect(reports.submitted).toBe(192);
      expect(reports.routing.avgMinutes).toBeGreaterThan(0);
      expect(reports.firstResponse.avgMinutes).toBeGreaterThan(0);
      expect(reports.resolution.avgHours).toBeGreaterThan(0);
      const evaluation = await get(admin, `/api/admin/reports/ai-evaluation?${window}`);
      expect(evaluation.overall.withoutRecommendation).toBeGreaterThan(0);
      expect(evaluation.overall.accuracyPct).toBeGreaterThan(0);
      expect(evaluation.overall.accuracyPct).toBeLessThan(100);
      expect(evaluation.byModel).toHaveLength(2);

      const review = await app.inject({
        method: 'POST',
        url: `${recommendationPath}/${recommendation.id}/review`,
        headers: tara,
        payload: { decision: 'ACCEPTED', expectedVersion: 1 },
      });
      expect(review.statusCode).toBe(200);
      expect(review.json().data).toMatchObject({
        decision: 'ACCEPTED',
        ticket: { status: 'TRIAGED' },
      });
    } finally {
      await app.close();
    }
  });

  it('covers every ticket status, review status, role and event type the issue requires', async () => {
    await seed('test');
    const distinct = async (sql: string) =>
      (await prisma.$queryRawUnsafe<{ v: string }[]>(sql)).map((r) => r.v);

    expect(await distinct('SELECT DISTINCT status AS v FROM tickets ORDER BY 1')).toEqual([
      'CLOSED',
      'IN_PROGRESS',
      'OPEN',
      'RESOLVED',
      'TRIAGED',
    ]);
    expect(
      await distinct('SELECT DISTINCT review_status AS v FROM ai_recommendations ORDER BY 1'),
    ).toEqual(['ACCEPTED', 'OVERRIDDEN', 'PENDING', 'REJECTED']);
    expect(await distinct('SELECT DISTINCT role AS v FROM users ORDER BY 1')).toEqual([
      'ADMIN',
      'EMPLOYEE',
      'TECHNICIAN',
    ]);
    const eventTypes = await distinct('SELECT DISTINCT event_type AS v FROM ticket_events');
    for (const type of [
      'CREATED',
      'TEAM_ASSIGNED',
      'TEAM_REASSIGNED',
      'STATUS_CHANGED',
      'RESOLVED',
      'REOPENED',
      'AI_REVIEWED',
      'COMMENT_ADDED',
    ]) {
      expect(eventTypes).toContain(type);
    }
    const [system] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM ticket_events WHERE actor_id IS NULL`;
    expect(Number(system!.n)).toBeGreaterThanOrEqual(1);
  });

  it('keeps fixtures coherent: inactive records, internal notes, members, no AI on a labelled ticket', async () => {
    await seed('test');
    const one = async <T>(sql: string) => (await prisma.$queryRawUnsafe<T[]>(sql))[0]!;

    const inactive = await one<{ users: bigint; teams: bigint; categories: bigint }>(
      `SELECT (SELECT COUNT(*) FROM users WHERE NOT is_active) AS users,
              (SELECT COUNT(*) FROM support_teams WHERE NOT is_active) AS teams,
              (SELECT COUNT(*) FROM ticket_categories WHERE NOT is_active) AS categories`,
    );
    expect([inactive.users, inactive.teams, inactive.categories].map(Number)).toEqual([2, 1, 1]);

    const comments = await one<{ internal: bigint; public: bigint }>(
      `SELECT COUNT(*) FILTER (WHERE is_internal) AS internal,
              COUNT(*) FILTER (WHERE NOT is_internal) AS public FROM ticket_comments`,
    );
    expect(Number(comments.internal)).toBe(1);
    expect(Number(comments.public)).toBe(5);

    // A technician in two teams, and a published + a draft article.
    const multi = await one<{ n: bigint }>(
      `SELECT COUNT(*) AS n FROM (SELECT user_id FROM team_members GROUP BY user_id HAVING COUNT(*) > 1) x`,
    );
    expect(Number(multi.n)).toBe(1);
    const articles = await one<{ published: bigint; draft: bigint }>(
      `SELECT COUNT(*) FILTER (WHERE is_published) AS published,
              COUNT(*) FILTER (WHERE NOT is_published) AS draft FROM knowledge_articles`,
    );
    expect([Number(articles.published), Number(articles.draft)]).toEqual([4, 1]);

    const noAi = await one<{ n: bigint }>(
      `SELECT COUNT(*) AS n FROM classification_labels l
       WHERE NOT EXISTS (SELECT 1 FROM ai_recommendations r WHERE r.ticket_id = l.ticket_id)`,
    );
    expect(Number(noAi.n)).toBe(1);

    // The reopened ticket has no current resolution but keeps its RESOLVED event.
    const reopened = await one<{
      resolved_at: Date | null;
      summary: string | null;
      resolved: bigint;
    }>(
      `SELECT t.resolved_at, t.resolution_summary AS summary,
              (SELECT COUNT(*) FROM ticket_events e WHERE e.ticket_id = t.ticket_id
                 AND e.event_type = 'RESOLVED') AS resolved
       FROM tickets t WHERE t.ticket_id = '${TICKETS.reopened}'`,
    );
    expect(reopened.resolved_at).toBeNull();
    expect(reopened.summary).toBeNull();
    expect(Number(reopened.resolved)).toBe(1);
  });

  it('labels never copy the AI prediction by construction', async () => {
    await seed('test');
    const rows = await prisma.$queryRaw<{ ticket_id: string; same: boolean }[]>`
      SELECT l.ticket_id, (r.proposed_category_id = l.reference_category_id) AS same
      FROM classification_labels l
      JOIN LATERAL (SELECT proposed_category_id FROM ai_recommendations
                    WHERE ticket_id = l.ticket_id ORDER BY created_at LIMIT 1) r ON true`;
    expect(rows.filter((r) => r.same)).toHaveLength(2);
    expect(rows.filter((r) => !r.same)).toHaveLength(2);
  });

  it('contains no plaintext credentials or secrets (only Argon2id password hashes)', async () => {
    await seed('test');
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ~* '(password|secret|token_hash|api_key)'`;
    expect(columns).toEqual([{ column_name: 'password_hash' }]);
    const [{ bad }] = await prisma.$queryRaw<{ bad: bigint }[]>`
      SELECT COUNT(*) AS bad FROM users WHERE password_hash NOT LIKE '$argon2id$%'`;
    expect(Number(bad)).toBe(0);
    expect(USERS.admin).toBeDefined();
  });

  it('refuses to reset a database that is not a test database', () => {
    expect(() => assertResettable('postgres://u:p@localhost:5432/smartdesk')).toThrow(/Refusing/);
    expect(() => assertResettable('postgres://u:p@localhost:5432/smartdesk_prod')).toThrow(
      /Refusing/,
    );
    expect(() => assertResettable('postgres://u:p@localhost:5432/smartdesk_test')).not.toThrow();
  });

  it('countRows reports all eleven tables', async () => {
    expect(Object.keys(await countRows(prisma))).toHaveLength(11);
  });
});
