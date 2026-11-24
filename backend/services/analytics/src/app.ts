import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import { createReportQueries, createReportRoutes } from '@smartdesk/analytics';
import { API_PREFIX, type Role } from '@smartdesk/contracts';
import type { PrismaClient } from '@smartdesk/db';
import { ServiceRequestError } from '@smartdesk/service-runtime/delegated-identity';
import Fastify from 'fastify';

const queries = createReportQueries({
  forbidden: () =>
    new ServiceRequestError(403, 'You are not allowed to perform this action', {
      code: 'FORBIDDEN',
    }),
  invalidWindow: (message) => new ServiceRequestError(422, message, { code: 'VALIDATION' }),
});

export async function buildAnalyticsApp(options: {
  prisma: PrismaClient;
  resolvePrincipal: (
    authorization: string | undefined,
    requestId: string,
  ) => Promise<{ id: string; role: Role }>;
  frontendOrigin: string;
  logLevel: string;
}) {
  const app = Fastify({
    logger: {
      level: options.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });
  await app.register(cors, {
    origin: options.frontendOrigin,
    credentials: true,
    methods: ['GET', 'HEAD'],
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, req, reply) => {
    const known = error instanceof ServiceRequestError;
    const transportStatus =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 0;
    const status = known
      ? error.status
      : transportStatus >= 400 && transportStatus < 500
        ? transportStatus
        : 503;
    const names: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      422: 'Unprocessable Entity',
      503: 'Service Unavailable',
    };
    if (status === 503) req.log.warn('Analytics request unavailable');
    reply.code(status).send({
      message: known
        ? error.message
        : status === 503
          ? 'Analytics temporarily unavailable'
          : 'Malformed request',
      data: null,
      error: names[status] ?? 'Error',
      details: known ? error.details : null,
    });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      message: `Route ${req.method} ${req.url} not found`,
      error: 'Not Found',
      details: null,
      data: null,
    });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await options.prisma.$queryRaw`SELECT ticket_id FROM public.tickets LIMIT 0`;
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  await app.register(
    createReportRoutes({
      prisma: options.prisma,
      queries,
      resolveAdmin: async (req) => {
        const principal = await options.resolvePrincipal(req.headers.authorization, req.id);
        if (principal.role !== 'ADMIN') {
          throw new ServiceRequestError(403, 'You do not have permission to perform this action');
        }
        return principal.id;
      },
      badRequest: (details) => new ServiceRequestError(400, 'Validation failed', details),
    }),
    { prefix: `${API_PREFIX}/admin/reports` },
  );
  return app;
}
