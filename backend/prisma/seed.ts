/**
 * Seed synthetic fixtures.
 *
 *   npm run db:seed                                  # demo profile (default, inside backend)
 *   npm run db:seed -- --profile test --reset        # empty a *test* database first
 *
 * The fixture data and the insert logic live in src/db/seed so tests can reuse them.
 */
import { createPrisma } from '@smartdesk/db';
import { seedDatabase } from '../src/db/seed/run.js';
import type { Profile } from '../src/db/seed/fixtures.js';

function parseArgs(argv: string[]): { profile: Profile; reset: boolean } {
  let profile: Profile = 'demo';
  let reset = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reset') reset = true;
    else if (arg === '--profile') {
      const value = argv[++i];
      if (value !== 'demo' && value !== 'test')
        throw new Error('--profile must be "demo" or "test"');
      profile = value;
    } else if (arg !== '--') {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { profile, reset };
}

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://smartdesk:smartdesk@localhost:5432/smartdesk';
const { profile, reset } = parseArgs(process.argv.slice(2));
const prisma = createPrisma(databaseUrl);

try {
  const counts = await seedDatabase(prisma, { profile, reset, databaseUrl });
  console.log(`Seeded "${profile}" profile${reset ? ' (after reset)' : ''}. Row counts:`);
  console.table(counts);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
