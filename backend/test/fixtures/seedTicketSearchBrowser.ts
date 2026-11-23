import { createPrisma } from '@smartdesk/db';
import { USERS, uuid } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/smartdesk_search_e2e_test') {
  throw new Error(
    'Browser search fixtures require the disposable smartdesk_search_e2e_test database',
  );
}
const prisma = createPrisma(databaseUrl);
try {
  await seedDatabase(prisma, { profile: 'test', databaseUrl });
  await prisma.ticket.createMany({
    data: Array.from({ length: 13 }, (_, index) => ({
      id: uuid('ticket', 100 + index),
      requesterId: index === 12 ? USERS.omar : USERS.erin,
      title:
        index === 12
          ? 'Private browser diagnostic'
          : `Browser diagnostic ${String(index + 1).padStart(2, '0')}`,
      description: 'browserdiags details only visible on the ticket',
      createdAt: new Date('2026-03-15T12:00:00Z'),
    })),
    skipDuplicates: true,
  });
} finally {
  await prisma.$disconnect();
}
