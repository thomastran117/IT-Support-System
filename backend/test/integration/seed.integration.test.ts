import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EXPECTED, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { assertResettable, countRows, seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('seed fixtures (integration)', () => {
  const prisma = createTestPrisma();
  const seed = (profile: 'demo' | 'test', reset = false) =>
    seedDatabase(prisma, { profile, reset, databaseUrl: testDatabaseUrl! });

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

  it('demo profile is the test data plus two tickets and two articles', async () => {
    const counts = await seed('demo');
    expect(counts).toMatchObject({
      tickets: EXPECTED.rowCounts.tickets + 2,
      knowledge_articles: EXPECTED.rowCounts.knowledge_articles + 2,
      ticket_events: EXPECTED.rowCounts.ticket_events + 2,
    });
    // Seeding the larger profile over the smaller one only adds rows.
    await resetDatabase(prisma);
    await seed('test');
    expect(await seed('demo')).toEqual(counts);
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

  it('contains no credentials or secrets', async () => {
    await seed('test');
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ~* '(password|secret|token_hash|api_key)'`;
    expect(columns).toEqual([]);
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
