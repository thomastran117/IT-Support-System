import { createPrisma } from '@smartdesk/db';
import { z } from 'zod';
import { loadEnv } from '../src/config/env.js';
import { requeueFailedSearchIndexJob } from '../src/db/repositories/searchIndexJobs.js';

const [id, extra] = process.argv.slice(2);
const jobId = z.uuid().safeParse(id);
if (!jobId.success || extra !== undefined) {
  console.error('Usage: npm run search:requeue -- <failed-job-id>');
  process.exitCode = 1;
} else {
  const prisma = createPrisma(loadEnv().databaseUrl);
  try {
    if (await requeueFailedSearchIndexJob(prisma, jobId.data))
      console.log('Search indexing job requeued');
    else {
      console.error('No failed search indexing job with that ID');
      process.exitCode = 1;
    }
  } catch {
    console.error('Could not requeue the search indexing job');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
