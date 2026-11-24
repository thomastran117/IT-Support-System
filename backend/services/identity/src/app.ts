import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  ANALYTICS_IDENTITY,
  API_PREFIX,
  KNOWLEDGE_IDENTITY,
  NOTIFICATION_IDENTITY,
  TICKET_IDENTITY,
} from '@smartdesk/contracts';
import type { PrismaClient } from '@smartdesk/db';
import {
  adminRoutes,
  authRoutes,
  createAccountAuthenticator,
  createAuthGuards,
  identityLookupRoutes,
  registerErrorHandling,
  TokenService,
} from '@smartdesk/identity';
import type { createFallbackRateLimitStore } from '@smartdesk/identity/rate-limit';
import { logHttpResponse, requestIdOptions, serviceLogger } from '@smartdesk/service-runtime';
import Fastify, { LogController } from 'fastify';
import type { loadServiceConfig } from './config.js';

export async function buildIdentityApp(options: {
  prisma: PrismaClient;
  session: ReturnType<typeof loadServiceConfig>['session'];
  internalServiceKeys: ReturnType<typeof loadServiceConfig>['internalServiceKeys'];
  logLevel: string;
  rateLimitStore?: ReturnType<typeof createFallbackRateLimitStore>;
}) {
  const { prisma, session, internalServiceKeys, logLevel, rateLimitStore } = options;
  const app = Fastify({
    // The private listener sits one hop behind the gateway, which replaces client XFF.
    trustProxy: (_address, hop) => hop === 0,
    ...requestIdOptions,
    logController: new LogController({ disableRequestLogging: true }),
    logger: serviceLogger('identity', logLevel),
  });
  app.addHook('onResponse', logHttpResponse);
  await app.register(cors, {
    origin: session.frontendOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    ...(rateLimitStore ? { store: rateLimitStore as unknown as never } : {}),
  });
  registerErrorHandling(app, false);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT user_id FROM public.users LIMIT 0`;
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  const tokens = new TokenService(session);
  const authenticate = createAccountAuthenticator(prisma, tokens);
  app.decorate('authGuards', createAuthGuards(authenticate));
  await app.register(
    authRoutes({
      prisma,
      env: session,
      tokens,
      rateLimit: { login: 10, refresh: 30, windowMs: 60_000 },
    }),
    { prefix: `${API_PREFIX}/auth` },
  );
  await app.register(adminRoutes(prisma), { prefix: `${API_PREFIX}/admin` });
  await app.register(
    identityLookupRoutes({
      authenticate,
      keys: internalServiceKeys,
      lookups: [TICKET_IDENTITY, NOTIFICATION_IDENTITY, ANALYTICS_IDENTITY, KNOWLEDGE_IDENTITY],
    }),
  );
  return app;
}
