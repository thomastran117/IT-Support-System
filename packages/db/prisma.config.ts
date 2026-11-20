import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // A placeholder keeps `prisma generate` working without a database (CI, Docker build).
    url: process.env.DATABASE_URL ?? 'postgresql://smartdesk:smartdesk@localhost:5432/smartdesk',
  },
});
