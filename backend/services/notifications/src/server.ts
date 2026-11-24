import { createPrisma } from '@smartdesk/db';
import { configuredEmailDispatcher, consumeNotificationEvents } from '@smartdesk/notifications';
import { buildNotificationsApp } from './app.js';
import { loadServiceConfig } from './config.js';
import { createRecipientResolver } from './identity.js';

const config = loadServiceConfig();
const resolveRecipient = await createRecipientResolver(config);
const prisma = createPrisma(config.databaseUrl);
const app = await buildNotificationsApp({ ...config, prisma, resolveRecipient });
const shutdown = new AbortController();
const mailer = configuredEmailDispatcher(prisma, config.email, config.pollMs, (entry) =>
  app.log[entry.errorKind && entry.state !== 'SENT' ? 'warn' : 'info'](entry),
);
let consumer: Promise<void> | undefined;
app.addHook('onClose', async () => {
  shutdown.abort();
  await Promise.all([consumer, mailer?.stop()]);
  await prisma.$disconnect();
});
const stop = () => {
  void app.close().catch(() => {
    app.log.error('Notifications shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.listen({ host: config.host, port: config.port });
consumer = consumeNotificationEvents(prisma, config.pollMs, shutdown.signal, (message) =>
  app.log.warn(message),
);
mailer?.start();
