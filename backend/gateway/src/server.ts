import { buildGateway } from './app.js';

const upstream = new URL(process.env.GATEWAY_UPSTREAM_URL ?? 'http://localhost:4001');
if (
  !['http:', 'https:'].includes(upstream.protocol) ||
  upstream.username ||
  upstream.password ||
  upstream.pathname !== '/' ||
  upstream.search ||
  upstream.hash
) {
  throw new Error('GATEWAY_UPSTREAM_URL must be an HTTP(S) origin');
}

const timeoutMs = Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? 10_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
  throw new Error('GATEWAY_UPSTREAM_TIMEOUT_MS must be an integer from 1 to 120000');
}

const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const proxy = process.env.TRUST_PROXY || 'false';
const trustProxy = proxy === 'true' || (proxy !== 'false' && proxy.split(',').map((s) => s.trim()));
const app = buildGateway({
  upstream,
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
