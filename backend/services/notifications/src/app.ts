import cors from '@fastify/cors';
import type { PrismaClient } from '@smartdesk/db';
import { createInboxRoutes } from '@smartdesk/notifications';
import { logHttpResponse, requestIdOptions, serviceLogger } from '@smartdesk/service-runtime';
import Fastify, { LogController } from 'fastify';
import { InboxRequestError } from './identity.js';

export async function buildNotificationsApp(options: {
  prisma: PrismaClient;
  resolveRecipient: (authorization: string | undefined, requestId: string) => Promise<string>;
  frontendOrigin: string;
  logLevel: string;
}) {
  const app = Fastify({
    ...requestIdOptions,
    logController: new LogController({ disableRequestLogging: true }),
    logger: serviceLogger('notifications', options.logLevel),
  });
  app.addHook('onResponse', logHttpResponse);
  await app.register(cors, {
    origin: options.frontendOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH'],
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, req, reply) => {
    const known = error instanceof InboxRequestError;
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
      404: 'Not Found',
      503: 'Service Unavailable',
    };
    if (status === 503) req.log.warn('Notifications request unavailable');
    reply.code(status).send({
      message: known
        ? error.message
        : status === 503
          ? 'Notifications temporarily unavailable'
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
      await options.prisma.$queryRaw`SELECT event_id FROM service_outbox_deliveries LIMIT 0`;
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  await app.register(
    createInboxRoutes(
      options.prisma,
      (req) => options.resolveRecipient(req.headers.authorization, req.id),
      (status, message, details) => new InboxRequestError(status, message, details),
    ),
    { prefix: '/api/notifications' },
  );
  return app;
}
