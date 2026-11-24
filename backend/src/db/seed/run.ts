import { backfillFirstResponse } from '../repositories/ticketComments.js';
import type { Prisma, PrismaClient } from '@smartdesk/db';
import { hashPassword } from '../../auth/password.js';
import { demoRoster } from './demoCatalog.js';
import { buildDemoActivity, DEMO_ANCHOR_TICKET, newDemoAnchor } from './demoFixtures.js';
import { buildFixtures, DEMO_PASSWORD, type Profile } from './fixtures.js';

// Hashing is deliberately slow, so hash each fixture user once per process. Salts are random, so
// hashes differ between runs; re-seeding never overwrites an existing row (ON CONFLICT DO NOTHING).
const hashCache = new Map<string, Promise<string>>();
const demoHash = (userId: string): Promise<string> => {
  let h = hashCache.get(userId);
  if (!h) {
    h = hashPassword(process.env.SEED_DEMO_PASSWORD ?? DEMO_PASSWORD).catch((error) => {
      hashCache.delete(userId);
      throw error;
    });
    hashCache.set(userId, h);
  }
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
  /** Clock input for the first demo seed. Existing installations reuse their saved anchor. */
  now?: Date;
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
 * Insert the fixtures in FK-safe order. Every insert is `ON CONFLICT DO NOTHING`, preserving
 * existing rows and append-only ticket events. The only backfills fill missing derived values.
 * Use `reset` (test databases only) to start from empty.
 */
export async function seedDatabase(
  prisma: PrismaClient,
  options: SeedOptions,
): Promise<SeedCounts> {
  if (options.reset) assertResettable(options.databaseUrl);

  const f = buildFixtures(options.profile);
  const roster = options.profile === 'demo' ? demoRoster : undefined;
  const identities = [...f.users, ...(roster?.users ?? [])];
  // Hash outside the transaction and bound the queue as each Argon2 hash uses its own memory.
  const users: (Prisma.UserCreateManyInput & { id: string; passwordHash: string })[] = [];
  for (let index = 0; index < identities.length; index += 4) {
    users.push(
      ...(await Promise.all(
        identities.slice(index, index + 4).map(async (user) => ({
          ...user,
          id: user.id!,
          passwordHash: await demoHash(user.id!),
        })),
      )),
    );
  }
  const opts = { skipDuplicates: true } as const;

  await prisma.$transaction(
    async (tx) => {
      // Two first-time seeds across UTC midnight must still agree on the same dated history.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('smartdesk:seed', 0))`;
      if (options.reset) {
        await tx.$executeRawUnsafe(
          `TRUNCATE ${[...TABLES, 'search_index_jobs', 'search_rebuilds'].map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
        );
      }
      const existingAnchor =
        roster &&
        (await tx.ticket.findUnique({
          where: { id: DEMO_ANCHOR_TICKET },
          select: { createdAt: true },
        }));
      const demo =
        roster &&
        buildDemoActivity(existingAnchor?.createdAt ?? newDemoAnchor(options.now ?? new Date()));
      const tickets = [...f.tickets, ...(demo?.tickets ?? [])];

      await tx.user.createMany({ data: users, ...opts });
      // Databases seeded before credentials existed: fill only missing hashes, never replace one.
      const missingHashes = new Set(
        (
          await tx.user.findMany({
            where: { id: { in: users.map(({ id }) => id) }, passwordHash: null },
            select: { id: true },
          })
        ).map(({ id }) => id),
      );
      for (const u of users) {
        if (missingHashes.has(u.id)) {
          await tx.user.updateMany({
            where: { id: u.id, passwordHash: null },
            data: { passwordHash: u.passwordHash },
          });
        }
      }
      await tx.supportTeam.createMany({ data: [...f.teams, ...(roster?.teams ?? [])], ...opts });
      await tx.teamMember.createMany({
        data: [...f.teamMembers, ...(roster?.teamMembers ?? [])],
        ...opts,
      });
      await tx.ticketCategory.createMany({
        data: [...f.categories, ...(roster?.categories ?? [])],
        ...opts,
      });
      await tx.ticket.createMany({ data: tickets, ...opts });
      await tx.ticketComment.createMany({
        data: [...f.comments, ...(demo?.comments ?? [])],
        ...opts,
      });
      // Comments are loaded in bulk here, so derive the stored first-response time the way the
      // service does when a comment is posted.
      await backfillFirstResponse(
        tx,
        tickets.map(({ id }) => id!),
      );
      await tx.ticketEvent.createMany({ data: [...f.events, ...(demo?.events ?? [])], ...opts });
      await tx.aiRecommendation.createMany({
        data: [...f.recommendations, ...(demo?.recommendations ?? [])],
        ...opts,
      });
      await tx.knowledgeArticle.createMany({
        data: [...f.articles, ...(demo?.articles ?? [])],
        ...opts,
      });
      await tx.recommendationArticle.createMany({
        data: [...f.recommendationArticles, ...(demo?.recommendationArticles ?? [])],
        ...opts,
      });
      await tx.classificationLabel.createMany({
        data: [...f.labels, ...(demo?.labels ?? [])],
        ...opts,
      });
      if (demo) await tx.notification.createMany({ data: demo.notifications, ...opts });
    },
    { timeout: 30_000 },
  );

  const counts = await countRows(prisma);
  if (roster) counts.notifications = await prisma.notification.count();
  return counts;
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
