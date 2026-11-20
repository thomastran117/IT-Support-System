/**
 * Run the database integration suite against a brand-new, isolated PostgreSQL database.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/smartdesk_test npm run test:db
 *
 * It connects to the server in TEST_DATABASE_URL, creates a uniquely named throw-away database
 * (name always contains "test"), applies every migration with `prisma migrate deploy`, runs the
 * integration tests against it and drops it again, whatever the outcome.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPrisma } from '@smartdesk/db';

const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!base) {
  console.error('Set TEST_DATABASE_URL (a PostgreSQL server you may create databases on).');
  process.exit(2);
}

const baseName = new URL(base).pathname.replace(/^\//, '') || 'smartdesk';
const dbName = `${/test/i.test(baseName) ? baseName : `${baseName}_test`}_${randomBytes(4).toString('hex')}`;

const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const runUrl = new URL(base);
runUrl.pathname = `/${dbName}`;

const admin = createPrisma(adminUrl.toString());
const quoted = `"${dbName.replace(/"/g, '""')}"`;

function run(args: string[]): number {
  const result = spawnSync('npm', args, {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), // repo root, so `-w backend` resolves
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: runUrl.toString(), TEST_DATABASE_URL: runUrl.toString() },
  });
  return result.status ?? 1;
}

let status = 1;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE ${quoted}`);
  console.log(`Created isolated database ${dbName}`);
  status = run(['run', 'migrate', '-w', 'backend']);
  if (status === 0) status = run(['run', 'test:integration', '-w', 'backend']);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
} finally {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`).catch((err) => {
    console.error(`Could not drop ${dbName}:`, err instanceof Error ? err.message : err);
  });
  await admin.$disconnect();
  console.log(`Dropped ${dbName}`);
}
process.exit(status);
