import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { renderDictionary, renderErd, type SchemaSpec } from '../../src/db/docs/render.js';
import { listEmployeeTickets } from '../../src/db/repositories/operationalQueries.js';
import { USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, insertRow, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const docs = fileURLToPath(new URL('../../../docs/database/', import.meta.url));
const read = (file: string) => readFileSync(`${docs}${file}`, 'utf8');
const spec = JSON.parse(read('schema-spec.json')) as SchemaSpec;
const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

describe('documentation is generated from the spec', () => {
  it('erd.md and data-dictionary.md match schema-spec.json (run the Compose docs service)', () => {
    expect(read('erd.md')).toBe(renderErd(spec));
    expect(read('data-dictionary.md')).toBe(renderDictionary(spec));
  });

  it('documents the eleven core entities plus the runtime extensions', () => {
    expect(spec.tables.map((t) => t.name)).toEqual([
      'users',
      'support_teams',
      'team_members',
      'ticket_categories',
      'tickets',
      'ticket_comments',
      'ticket_events',
      'ai_recommendations',
      'knowledge_articles',
      'recommendation_articles',
      'classification_labels',
      // Runtime extension to the original ticketing schema.
      'admin_audit_log',
      'ai_analysis_jobs',
      'notifications',
      'notification_deliveries',
      'search_index_jobs',
    ]);
    for (const table of spec.tables) expect(read('erd.md')).toContain(`  ${table.name} {`);
  });
});

describe.skipIf(!testDatabaseUrl)('schema-spec.json matches the migrated PostgreSQL schema', () => {
  const prisma = createTestPrisma();
  afterAll(() => prisma.$disconnect());

  it('has exactly the documented tables', async () => {
    const rows = await prisma.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`;
    expect(rows.map((r) => r.relname).sort()).toEqual(spec.tables.map((t) => t.name).sort());
  });

  it('matches every column: order, type, nullability and default', async () => {
    const rows = await prisma.$queryRaw<
      { table: string; name: string; type: string; nullable: boolean; def: string | null }[]
    >`
      SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname, a.attnum`;
    const actual = spec.tables.map((t) =>
      rows
        .filter((r) => r.table === t.name)
        .map((r) => ({ name: r.name, type: r.type, nullable: r.nullable, default: r.def })),
    );
    const documented = spec.tables.map((t) =>
      t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        default: c.default,
      })),
    );
    expect(actual).toEqual(documented);
  });

  it('matches primary keys, foreign keys (incl. composite) and delete rules', async () => {
    const rows = await prisma.$queryRaw<
      {
        table: string;
        name: string;
        type: string;
        cols: string[];
        ref_table: string | null;
        ref_cols: string[] | null;
        on_delete: string;
      }[]
    >`
      SELECT c.conrelid::regclass::text AS "table", c.conname::text AS name, c.contype::text AS type,
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
        c.confrelid::regclass::text AS ref_table,
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_cols,
        c.confdeltype::text AS on_delete
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype IN ('p', 'f') AND c.conrelid::regclass::text <> '_prisma_migrations'
      ORDER BY 1, 3, 2`;

    for (const t of spec.tables) {
      const pk = rows.find((r) => r.table === t.name && r.type === 'p');
      expect(pk?.cols, `${t.name} primary key`).toEqual(t.primaryKey);
      const fks = rows
        .filter((r) => r.table === t.name && r.type === 'f')
        .sort(byName)
        .map((r) => ({
          name: r.name,
          columns: r.cols,
          references: { table: r.ref_table, columns: r.ref_cols },
          onDelete: r.on_delete === 'r' ? 'RESTRICT' : r.on_delete,
        }));
      expect(fks, `${t.name} foreign keys`).toEqual([...t.foreignKeys].sort(byName));
    }
  });

  it('matches CHECK constraints (name and rule) exactly', async () => {
    const rows = await prisma.$queryRaw<{ table: string; name: string; rule: string }[]>`
      SELECT c.conrelid::regclass::text AS "table", c.conname::text AS name,
             -- strip the leading "CHECK (" and trailing ")"
             substr(pg_get_constraintdef(c.oid), 8, length(pg_get_constraintdef(c.oid)) - 8) AS rule
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'c'
      ORDER BY 1, 2`;
    for (const t of spec.tables) {
      const actual = rows
        .filter((r) => r.table === t.name)
        .sort(byName)
        .map(({ name, rule }) => ({ name, rule }));
      expect(actual, `${t.name} checks`).toEqual([...t.checks].sort(byName));
    }
  });

  it('matches indexes: names, ordered columns and uniqueness', async () => {
    const rows = await prisma.$queryRaw<
      { table: string; name: string; unique: boolean; cols: string[] }[]
    >`
      SELECT t.relname::text AS "table", i.relname::text AS name, x.indisunique AS "unique",
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(x.indkey::int[]) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS cols
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname <> '_prisma_migrations'
      ORDER BY 1, 2`;
    for (const t of spec.tables) {
      const actual = rows
        .filter((r) => r.table === t.name)
        .sort(byName)
        // Expression indexes (e.g. full-text) have no plain columns; the spec calls them "(expression)".
        .map((r) => ({ name: r.name, columns: r.cols ?? ['(expression)'], unique: r.unique }));
      expect(actual, `${t.name} indexes`).toEqual([...t.indexes].sort(byName));
    }
  });

  it('declares every issue-required index', () => {
    const wanted: Record<string, string[]> = {
      tickets: [
        'requester_id,created_at',
        'assigned_team_id,status,created_at',
        'category_id,created_at',
      ],
      ticket_events: ['ticket_id,occurred_at,event_id'],
      ticket_comments: ['ticket_id,created_at'],
      ai_recommendations: ['ticket_id,created_at,recommendation_id'],
      classification_labels: ['reference_category_id'],
      team_members: ['user_id'],
      recommendation_articles: ['article_id'],
    };
    for (const [table, lists] of Object.entries(wanted)) {
      const have = spec.tables
        .find((t) => t.name === table)!
        .indexes.map((i) => i.columns.join(','));
      for (const cols of lists) expect(have, `${table}(${cols})`).toContain(cols);
    }
  });
});

describe.skipIf(!testDatabaseUrl)('column semantics (integration)', () => {
  const prisma = createTestPrisma();
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('generates UUID v4 keys and defaults timestamps in UTC-aware TIMESTAMPTZ', async () => {
    await resetDatabase(prisma);
    const user = await insertRow(prisma, 'users', {
      email: 'precision@example.test',
      display_name: 'Precision',
      role: 'EMPLOYEE',
    });
    expect(user.user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // The same instant written with a +05:00 offset is stored and read back as UTC, to the microsecond.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tickets (requester_id, title, description, created_at, updated_at)
       VALUES ($1::uuid, 't', 'd', '2026-03-01T12:00:00.123456+05:00', '2026-03-01T12:00:00.123456+05:00')`,
      user.user_id,
    );
    const [row] = await prisma.$queryRaw<{ utc: string; type: string }[]>`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS utc,
             pg_typeof(created_at)::text AS type FROM tickets`;
    expect(row).toEqual({ utc: '2026-03-01T07:00:00.123456', type: 'timestamp with time zone' });
  });

  it('keeps independent labels and AI proposals out of employee-facing results', async () => {
    await seedDatabase(prisma, { profile: 'test', reset: true, databaseUrl: testDatabaseUrl! });
    const rows = await listEmployeeTickets(prisma, USERS.erin);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'createdAt',
        'priority',
        'status',
        'ticketId',
        'title',
        'updatedAt',
      ]);
    }
  });
});
