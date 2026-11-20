/**
 * Renders docs/database/erd.md and docs/database/data-dictionary.md from schema-spec.json.
 * The integration tests verify the spec against the migrated PostgreSQL schema and that the
 * committed Markdown equals this output, so the documents cannot drift from the deployed schema.
 */

export interface SpecColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  meaning: string;
}
export interface SpecForeignKey {
  name: string;
  columns: string[];
  references: { table: string; columns: string[] };
  onDelete: string;
}
export interface SpecIndex {
  name: string;
  columns: string[];
  unique: boolean;
}
export interface SpecTable {
  name: string;
  area: string;
  description: string;
  columns: SpecColumn[];
  primaryKey: string[];
  foreignKeys: SpecForeignKey[];
  checks: { name: string; rule: string }[];
  indexes: SpecIndex[];
}
export interface SchemaSpec {
  tables: SpecTable[];
}

const HEADER =
  '<!-- Generated from schema-spec.json by `npm run docs:db -w backend`. Do not edit by hand. -->';

const mermaidType = (type: string): string => {
  if (type.startsWith('character varying')) return 'varchar';
  if (type.startsWith('timestamp')) return 'timestamptz';
  if (type.startsWith('numeric')) return 'numeric';
  if (type === 'integer') return 'int';
  if (type === 'boolean') return 'bool';
  return type;
};

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((c) => b.includes(c));

export function renderErd(spec: SchemaSpec): string {
  const byName = new Map(spec.tables.map((t) => [t.name, t]));
  const lines: string[] = [
    HEADER,
    '',
    '# Entity-relationship diagram',
    '',
    'The eleven core SmartDesk entities as deployed by the Prisma migrations. Field details are in',
    '[data-dictionary.md](./data-dictionary.md); rules and enumerations are in [README.md](./README.md).',
    '',
    '```mermaid',
    'erDiagram',
  ];

  for (const t of spec.tables) {
    lines.push(`  ${t.name} {`);
    for (const c of t.columns) {
      const keys: string[] = [];
      if (t.primaryKey.includes(c.name)) keys.push('PK');
      if (t.foreignKeys.some((fk) => fk.columns.includes(c.name))) keys.push('FK');
      lines.push(`    ${mermaidType(c.type)} ${c.name}${keys.length ? ` ${keys.join(',')}` : ''}`);
    }
    lines.push('  }');
  }

  const relationships: string[] = [];
  for (const child of spec.tables) {
    for (const fk of child.foreignKeys) {
      const parent = byName.get(fk.references.table)!;
      const optional = fk.columns.some((c) => child.columns.find((x) => x.name === c)!.nullable);
      const oneToOne = sameSet(fk.columns, child.primaryKey);
      const parentEnd = optional ? '|o' : '||';
      const childEnd = oneToOne ? 'o|' : 'o{';
      lines.push(
        `  ${parent.name} ${parentEnd}--${childEnd} ${child.name} : "${fk.columns.join(', ')}"`,
      );
      relationships.push(
        `| \`${child.name}\` | \`${fk.columns.join(', ')}\` | \`${parent.name}\` (\`${fk.references.columns.join(', ')}\`) | ${
          oneToOne ? '1 : 0..1' : optional ? '0..1 : N' : '1 : N'
        } | ${optional ? 'optional' : 'required'} | ${fk.onDelete} |`,
      );
    }
  }
  lines.push('```', '');
  lines.push(
    '## Relationships',
    '',
    'Cardinality is `parent : child`. Every foreign key is `ON DELETE RESTRICT`: history is deactivated,',
    'never cascaded away. `tickets` references `users` twice (requester and assignee) and `team_members`',
    'through the composite key `(assigned_team_id, assignee_id)`, which guarantees the assignee belongs to',
    'the assigned team.',
    '',
    '| Child table | Foreign key | Parent | Cardinality | Presence | On delete |',
    '| --- | --- | --- | --- | --- | --- |',
    ...relationships,
    '',
  );
  return lines.join('\n');
}

const esc = (s: string) => s.replace(/\|/g, '\\|');
const code = (s: string) => `\`${esc(s)}\``;

export function renderDictionary(spec: SchemaSpec): string {
  const out: string[] = [
    HEADER,
    '',
    '# Data dictionary',
    '',
    'Every column of the eleven core tables, as deployed by the migrations in `backend/prisma/migrations`.',
    'Types are PostgreSQL types (`timestamp(6) with time zone` is `TIMESTAMPTZ`; all times are UTC).',
    '',
  ];

  for (const t of spec.tables) {
    out.push(`## \`${t.name}\``, '', `_${t.area}._ ${t.description}`, '');
    out.push(
      '| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const c of t.columns) {
      const key: string[] = [];
      if (t.primaryKey.includes(c.name))
        key.push(t.primaryKey.length > 1 ? 'PK (composite)' : 'PK');
      for (const fk of t.foreignKeys) {
        if (!fk.columns.includes(c.name)) continue;
        const target =
          fk.columns.length > 1
            ? `${fk.references.table}(${fk.references.columns.join(', ')}) composite`
            : `${fk.references.table}.${fk.references.columns[0]}`;
        key.push(`FK → ${target}`);
      }
      const unique = t.indexes
        .filter((i) => i.unique && !i.name.endsWith('_pkey') && i.columns.includes(c.name))
        .map((i) =>
          i.columns.length > 1 ? `with ${i.columns.filter((x) => x !== c.name).join(', ')}` : 'yes',
        );
      const indexes = t.indexes
        .filter((i) => !i.name.endsWith('_pkey') && i.columns.includes(c.name))
        .map((i) => code(i.name));
      out.push(
        `| ${code(c.name)} | ${code(c.type)} | ${c.nullable ? 'NULL' : 'NOT NULL'} | ${
          c.default ? code(c.default) : ''
        } | ${esc(key.join('; '))} | ${unique.join('; ')} | ${indexes.join(', ')} | ${esc(c.meaning)} |`,
      );
    }
    out.push('');
    if (t.checks.length) {
      out.push('**CHECK constraints**', '');
      for (const k of t.checks) out.push(`- ${code(k.name)}: ${code(k.rule)}`);
      out.push('');
    }
  }
  return out.join('\n');
}
