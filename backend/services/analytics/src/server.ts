import { ANALYTICS_IDENTITY, analyticsPrincipalSchema } from '@smartdesk/contracts';
import { createPrisma } from '@smartdesk/db';
import { createDelegatedIdentityResolver } from '@smartdesk/service-runtime/delegated-identity';
import { buildAnalyticsApp } from './app.js';
import { loadServiceConfig } from './config.js';

const config = loadServiceConfig();
const resolvePrincipal = await createDelegatedIdentityResolver({
  ...config,
  keySetting: 'ANALYTICS_PRIVATE_KEY',
  service: 'analytics',
  route: ANALYTICS_IDENTITY,
  decode: (body) => analyticsPrincipalSchema.parse(body),
});
const prisma = createPrisma(config.databaseUrl);
const app = await buildAnalyticsApp({ ...config, prisma, resolvePrincipal });
app.addHook('onClose', () => prisma.$disconnect());
const stop = () => {
  void app.close().catch(() => {
    app.log.error('Analytics shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.listen({ host: config.host, port: config.port });
