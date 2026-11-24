import { parseExecutionMode, parseHttpOrigin, parseInteger } from '@smartdesk/service-runtime';
import { buildGateway } from './app.js';

const ticketMode = parseExecutionMode('TICKET_EXECUTION_MODE', process.env.TICKET_EXECUTION_MODE);
const upstream =
  ticketMode === 'local'
    ? parseHttpOrigin(
        'GATEWAY_UPSTREAM_URL',
        process.env.GATEWAY_UPSTREAM_URL ?? 'http://localhost:4001',
      )
    : undefined;
const ticketUpstream =
  ticketMode === 'service'
    ? parseHttpOrigin(
        'GATEWAY_TICKET_ORIGIN',
        process.env.GATEWAY_TICKET_ORIGIN ?? 'http://localhost:4060',
      )
    : undefined;
const timeoutMs = parseInteger(
  'GATEWAY_UPSTREAM_TIMEOUT_MS',
  process.env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? 10_000,
  1,
  120_000,
);
const port = parseInteger('PORT', process.env.PORT ?? 4000, 1, 65535);

const proxy = process.env.TRUST_PROXY || 'false';
const trustProxy = proxy === 'true' || (proxy !== 'false' && proxy.split(',').map((s) => s.trim()));
const app = buildGateway({
  upstream,
  ticketUpstream,
  notificationsUpstream:
    process.env.NOTIFICATIONS_EXECUTION_MODE === 'service'
      ? parseHttpOrigin(
          'GATEWAY_NOTIFICATIONS_ORIGIN',
          process.env.GATEWAY_NOTIFICATIONS_ORIGIN ?? 'http://localhost:4020',
        )
      : undefined,
  analyticsUpstream:
    process.env.ANALYTICS_EXECUTION_MODE === 'service'
      ? parseHttpOrigin(
          'GATEWAY_ANALYTICS_ORIGIN',
          process.env.GATEWAY_ANALYTICS_ORIGIN ?? 'http://localhost:4030',
        )
      : undefined,
  knowledgeUpstream:
    process.env.KNOWLEDGE_EXECUTION_MODE === 'service'
      ? parseHttpOrigin(
          'GATEWAY_KNOWLEDGE_ORIGIN',
          process.env.GATEWAY_KNOWLEDGE_ORIGIN ?? 'http://localhost:4040',
        )
      : undefined,
  identityUpstream:
    process.env.IDENTITY_EXECUTION_MODE === 'service'
      ? parseHttpOrigin(
          'GATEWAY_IDENTITY_ORIGIN',
          process.env.GATEWAY_IDENTITY_ORIGIN ?? 'http://localhost:4050',
        )
      : undefined,
  timeoutMs,
  trustProxy,
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  logLevel: process.env.LOG_LEVEL ?? 'info',
});

const stop = () => {
  void app.close().catch((err: unknown) => {
    app.log.error({ err }, 'Gateway shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });
