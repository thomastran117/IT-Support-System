import type { HealthStatus, LiveHealth, ReadyHealth } from '@smartdesk/contracts';
import Fastify from 'fastify';
import type { loadServiceConfig } from './config.js';

type ServiceConfig = ReturnType<typeof loadServiceConfig>;
type Readiness = { status: HealthStatus; checks: { ticketApi: HealthStatus } };

async function checkTicketApi(url: URL, timeoutMs: number): Promise<HealthStatus> {
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
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
  const app = Fastify({ logger: { level: config.logLevel } });
  const ticketHealth = new URL('/health/ready', config.ticketOrigin);
  app.get('/health/live', async (): Promise<LiveHealth> => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply): Promise<Readiness> => {
    const status = await checkTicketApi(ticketHealth, config.readyTimeoutMs);
    reply.header('cache-control', 'no-store');
    if (status === 'unavailable') reply.code(503);
    return { status, checks: { ticketApi: status } };
  });
  return app;
}
