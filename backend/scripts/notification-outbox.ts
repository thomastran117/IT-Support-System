import { createPrisma } from '@smartdesk/db';
import { z } from 'zod';
import { loadEnv } from '../src/config/env.js';
import {
  drainNotificationEvents,
  notificationSubscription,
  replayServiceEvent,
} from '@smartdesk/notifications';

const [mode, id, extra] = process.argv.slice(2);
const eventId = z.uuid().safeParse(id);
if (!((mode === 'drain' && id === undefined) || (mode === 'replay' && eventId.success && !extra))) {
  console.error('Usage: npm run outbox:notifications -- drain | replay <failed-event-id>');
  process.exitCode = 1;
} else {
  const db = createPrisma(loadEnv().databaseUrl);
  try {
    if (mode === 'replay' && eventId.success) {
      if (await replayServiceEvent(db, notificationSubscription.name, eventId.data)) {
        console.log('Notification event requeued');
      } else {
        console.error('No failed notification event with that ID');
        process.exitCode = 1;
      }
    } else {
      const results = await drainNotificationEvents(db);
      console.log(JSON.stringify(results));
      if (results.FAILED) process.exitCode = 1;
    }
  } catch {
    console.error('Could not process notification outbox');
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
