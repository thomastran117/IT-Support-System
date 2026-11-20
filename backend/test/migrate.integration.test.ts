import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';

const url = process.env.TEST_DATABASE_URL;

// Runs only when a database is provided (CI, or locally via TEST_DATABASE_URL).
describe.skipIf(!url)('migrations (integration)', () => {
  it('applies on a fresh database and is idempotent', async () => {
    const first = await migrate(url!);
    const second = await migrate(url!);
    expect(second).toEqual([]);
    expect(first.length === 0 || first.includes('0000_init.sql')).toBe(true);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query('SELECT count(*)::int AS n FROM schema_migrations');
    await client.end();
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
