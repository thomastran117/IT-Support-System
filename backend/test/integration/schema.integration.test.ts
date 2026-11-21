import { createPrisma } from '@smartdesk/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;

const EXTENSION_TABLES = ['admin_audit_log', 'ai_analysis_jobs'];

const CORE_TABLES = [
  'ai_recommendations',
  'classification_labels',
  'knowledge_articles',
  'recommendation_articles',
  'support_teams',
  'team_members',
  'ticket_categories',
  'ticket_comments',
  'ticket_events',
  'tickets',
  'users',
];

// Runs only against a migrated, disposable database (CI runs `npm run migrate` first).
describe.skipIf(!url)('core schema (integration)', () => {
  const prisma = createPrisma(url!);

  const reset = () =>
    prisma.$executeRawUnsafe(
      `TRUNCATE ${CORE_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );

  beforeAll(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it('creates exactly the eleven core tables plus the documented extension tables', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
      ORDER BY table_name`;
    // The runtime schema includes the administrator audit extension.
    expect(rows.map((r) => r.table_name)).toEqual([...CORE_TABLES, ...EXTENSION_TABLES].sort());
  });

  it('uses composite or shared primary keys where specified', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; cols: string }[]>`
      SELECT c.conrelid::regclass::text AS table_name,
             string_agg(a.attname, ',' ORDER BY k.ord) AS cols
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'p'
        AND c.conrelid::regclass::text IN
          ('team_members', 'recommendation_articles', 'classification_labels')
      GROUP BY c.conrelid, c.conname
      ORDER BY 1`;
    expect(rows).toEqual([
      { table_name: 'classification_labels', cols: 'ticket_id' },
      { table_name: 'recommendation_articles', cols: 'recommendation_id,article_id' },
      { table_name: 'team_members', cols: 'team_id,user_id' },
    ]);
  });

  it('declares every foreign key as RESTRICT (no cascading deletes)', async () => {
    const rows = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint WHERE contype = 'f'`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.confdeltype !== 'r')).toEqual([]);
  });

  it('stores a full example graph through the Prisma client', async () => {
    const employee = await prisma.user.create({
      data: { email: 'employee@example.test', displayName: 'Eve Employee', role: 'EMPLOYEE' },
    });
    const tech = await prisma.user.create({
      data: { email: 'tech@example.test', displayName: 'Tom Tech', role: 'TECHNICIAN' },
    });
    const team = await prisma.supportTeam.create({ data: { name: 'Service Desk' } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: tech.id } });
    const category = await prisma.ticketCategory.create({ data: { name: 'Network/VPN' } });

    const ticket = await prisma.ticket.create({
      data: {
        requesterId: employee.id,
        title: 'VPN drops every hour',
        description: 'Disconnects from the VPN roughly every 60 minutes.',
      },
    });
    // New tickets start OPEN / UNSET with no approved team, category or assignee.
    expect(ticket).toMatchObject({
      status: 'OPEN',
      priority: 'UNSET',
      assignedTeamId: null,
      assigneeId: null,
      categoryId: null,
      resolvedAt: null,
      resolutionSummary: null,
    });

    await prisma.ticketComment.create({
      data: { ticketId: ticket.id, authorId: tech.id, body: 'Looking into it', isInternal: true },
    });
    const event = await prisma.ticketEvent.create({
      data: { ticketId: ticket.id, actorId: null, eventType: 'CREATED' },
    });
    expect(event.details).toEqual({});

    const rec = await prisma.aiRecommendation.create({
      data: {
        ticketId: ticket.id,
        proposedCategoryId: category.id,
        proposedTeamId: team.id,
        proposedPriority: 'HIGH',
        confidence: '0.873',
        modelVersion: 'test-model-1',
      },
    });
    expect(rec.reviewStatus).toBe('PENDING');
    expect(rec.confidence?.toString()).toBe('0.873');

    const article = await prisma.knowledgeArticle.create({
      data: { title: 'Fix VPN drops', body: 'Update the client.' },
    });
    await prisma.recommendationArticle.create({
      data: { recommendationId: rec.id, articleId: article.id, relevanceRank: 1 },
    });
    await prisma.classificationLabel.create({
      data: { ticketId: ticket.id, referenceCategoryId: category.id, labelledBy: tech.id },
    });

    for (const table of CORE_TABLES) {
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM "${table}"`,
      );
      expect(Number(n), table).toBeGreaterThan(0);
    }
  });

  it('refuses to delete referenced history instead of cascading', async () => {
    await expect(prisma.ticket.deleteMany()).rejects.toThrow();
    expect(await prisma.ticketEvent.count()).toBe(1);
    await expect(prisma.user.deleteMany()).rejects.toThrow();
  });
});
