import { backfillFirstResponse } from '../repositories/ticketComments.js';
import type { PrismaClient } from '@smartdesk/db';
import { hashPassword } from '../../auth/password.js';
import { buildFixtures, DEMO_PASSWORD, type Profile } from './fixtures.js';

// Hashing is deliberately slow, so hash each fixture user once per process. Salts are random, so
// hashes differ between runs; re-seeding never overwrites an existing row (ON CONFLICT DO NOTHING).
const hashCache = new Map<string, Promise<string>>();
const demoHash = (userId: string): Promise<string> => {
  let h = hashCache.get(userId);
  if (!h)
    hashCache.set(userId, (h = hashPassword(process.env.SEED_DEMO_PASSWORD ?? DEMO_PASSWORD)));
  return h;
};

const TABLES = [
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

export interface SeedOptions {
  profile: Profile;
  /** Delete all rows first. Only allowed for databases whose name contains "test". */
  reset?: boolean;
  databaseUrl: string;
}

export function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

/** Wiping data is only ever allowed on a database that is clearly a test database. */
export function assertResettable(databaseUrl: string): void {
  const name = databaseName(databaseUrl);
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to reset "${name}": --reset only works on databases named "*test*"`);
  }
}

export type SeedCounts = Record<string, number>;

/**
 * Insert the fixtures in FK-safe order. Every insert is `ON CONFLICT DO NOTHING`, so re-running is
 * a no-op and never touches existing rows (important for the append-only `ticket_events`).
 * Use `reset` (test databases only) to start from empty.
 */
export async function seedDatabase(
  prisma: PrismaClient,
  options: SeedOptions,
): Promise<SeedCounts> {
  if (options.reset) {
    assertResettable(options.databaseUrl);
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${[...TABLES, 'search_index_jobs'].map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }

  const f = buildFixtures(options.profile);
  const users = await Promise.all(
    f.users.map(async (u) => ({ ...u, passwordHash: await demoHash(u.id as string) })),
  );
  const opts = { skipDuplicates: true } as const;

  await prisma.$transaction(async (tx) => {
    await tx.user.createMany({ data: users, ...opts });
    // Databases seeded before credentials existed: fill only missing hashes, never replace one.
    for (const u of users) {
      await tx.user.updateMany({
        where: { id: u.id, passwordHash: null },
        data: { passwordHash: u.passwordHash },
      });
    }
    await tx.supportTeam.createMany({ data: f.teams, ...opts });
    await tx.teamMember.createMany({ data: f.teamMembers, ...opts });
    await tx.ticketCategory.createMany({ data: f.categories, ...opts });
    await tx.ticket.createMany({ data: f.tickets, ...opts });
    await tx.ticketComment.createMany({ data: f.comments, ...opts });
    // Comments are loaded in bulk here, so derive the stored first-response time the way the
    // service does when a comment is posted.
    await backfillFirstResponse(tx);
    await tx.ticketEvent.createMany({ data: f.events, ...opts });
    await tx.aiRecommendation.createMany({ data: f.recommendations, ...opts });
    await tx.knowledgeArticle.createMany({ data: f.articles, ...opts });
    await tx.recommendationArticle.createMany({ data: f.recommendationArticles, ...opts });
    await tx.classificationLabel.createMany({ data: f.labels, ...opts });
  });

  return countRows(prisma);
}

export async function countRows(prisma: PrismaClient): Promise<SeedCounts> {
  const counts: SeedCounts = {};
  for (const table of [...TABLES].sort()) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM "${table}"`,
    );
    counts[table] = Number(rows[0]!.n);
  }
  return counts;
}
