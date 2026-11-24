import { parseHttpOrigin, parseInteger } from '@smartdesk/service-runtime';
import { buildGateway } from './app.js';

const upstream = parseHttpOrigin(
  'GATEWAY_UPSTREAM_URL',
  process.env.GATEWAY_UPSTREAM_URL ?? 'http://localhost:4001',
);
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
  notificationsUpstream:
    process.env.NOTIFICATIONS_EXECUTION_MODE === 'service'
      ? parseHttpOrigin(
          'GATEWAY_NOTIFICATIONS_ORIGIN',
          process.env.GATEWAY_NOTIFICATIONS_ORIGIN ?? 'http://localhost:4020',
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
