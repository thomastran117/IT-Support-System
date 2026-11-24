import type { HealthStatus, LiveHealth, ReadyHealth } from '@smartdesk/contracts';
import {
  hashCorrelationId,
  logHttpResponse,
  requestIdOptions,
  serviceLogger,
} from '@smartdesk/service-runtime';
import Fastify, { LogController } from 'fastify';
import type { loadServiceConfig } from './config.js';

type ServiceConfig = ReturnType<typeof loadServiceConfig>;
type Readiness = { status: HealthStatus; checks: { ticketApi: HealthStatus } };

async function checkTicketApi(
  url: URL,
  timeoutMs: number,
  requestId: string,
): Promise<HealthStatus> {
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'x-request-id': requestId },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return 'unavailable';
    }
    const health = (await response.json()) as Partial<ReadyHealth> | null;
    return health?.status === 'ok' && health.checks?.database === 'ok' ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function buildAiService(config: ServiceConfig) {
  const app = Fastify({
    ...requestIdOptions,
    logController: new LogController({ disableRequestLogging: true }),
    logger: serviceLogger('ai', config.logLevel),
  });
  app.addHook('onResponse', logHttpResponse);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  const ticketHealth = new URL('/health/ready', config.ticketOrigin);
  app.get('/health/live', async (): Promise<LiveHealth> => ({ status: 'ok' }));
  app.get('/health/ready', async (req, reply): Promise<Readiness> => {
    const started = performance.now();
    const status = await checkTicketApi(ticketHealth, config.readyTimeoutMs, req.id);
    reply.header('cache-control', 'no-store');
    if (status === 'unavailable') {
      req.log.warn({
        event: 'dependency_failure',
        correlationId: hashCorrelationId(req.id),
        dependency: 'ticket',
        status: 503,
        errorKind: 'readiness_failed',
        durationMs: performance.now() - started,
      });
      reply.code(503);
    }
    return { status, checks: { ticketApi: status } };
  });
  return app;
}
