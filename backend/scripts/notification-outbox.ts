import { createPrisma } from '@smartdesk/db';
import { z } from 'zod';
import { loadEnv } from '../src/config/env.js';
import {
  claimServiceEvent,
  deliverServiceEvent,
  replayServiceEvent,
} from '../src/db/repositories/serviceOutbox.js';
import {
  applyNotificationEvent,
  notificationSubscription,
} from '../src/modules/notifications/outbox.js';

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
      const results = { COMPLETED: 0, QUEUED: 0, FAILED: 0, LOST: 0 };
      for (let index = 0; index < 100; index++) {
        const claim = await claimServiceEvent(db, notificationSubscription);
        if (!claim) break;
        const result = await deliverServiceEvent(db, claim, applyNotificationEvent);
        results[result]++;
      }
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
