import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_PREFIX } from '@smartdesk/contracts';
import type { Env } from './config/env.js';
import type { DbCheck, PrismaClient } from '@smartdesk/db';
import { createAuthGuards } from './auth/guard.js';
import { TokenService } from './auth/tokens.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { registerErrorHandling } from './plugins/errors.js';
import { adminKnowledgeRoutes, knowledgeRoutes } from './modules/knowledge/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { pingRoutes } from './modules/ping.js';
import { adminTeamRoutes, categoryRoutes, teamRoutes } from './modules/teams/routes.js';
import { technicianRoutes } from './modules/technician/routes.js';
import { ticketRoutes } from './modules/tickets/routes.js';

export interface AppOptions {
  env: Env;
  checkDb: DbCheck;
  /** Database client; the auth routes are only mounted when provided. */
  prisma?: PrismaClient;
  /** Per-IP request budgets for the auth endpoints (tests lower these). */
  authRateLimit?: { login: number; refresh: number; windowMs: number };
  /** Pass `false` to silence logs, or a pino options object (tests). */
  logger?: boolean | object;
  /** Extra routes registered under /api (used by tests). */
  extraRoutes?: (app: FastifyInstance) => void | Promise<void>;
}

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.content',
  '*.password',
  '*.accessToken',
  'req.cookies',
];

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? {
      level: opts.env.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  await app.register(cors, {
    origin: opts.env.frontendOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  registerErrorHandling(app);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(healthRoutes(opts.checkDb));
  await app.register(pingRoutes, { prefix: API_PREFIX });
  if (opts.prisma) {
    const tokens = new TokenService(opts.env);
    app.decorate('authGuards', createAuthGuards(opts.prisma, tokens));
    await app.register(
      authRoutes({
        prisma: opts.prisma,
        env: opts.env,
        tokens,
        rateLimit: opts.authRateLimit ?? { login: 10, refresh: 30, windowMs: 60_000 },
      }),
      { prefix: `${API_PREFIX}/auth` },
    );
    await app.register(adminRoutes(opts.prisma), { prefix: `${API_PREFIX}/admin` });
    await app.register(adminKnowledgeRoutes(opts.prisma), {
      prefix: `${API_PREFIX}/admin/knowledge`,
    });
    await app.register(knowledgeRoutes(opts.prisma), { prefix: `${API_PREFIX}/knowledge` });
    await app.register(adminTeamRoutes(opts.prisma), { prefix: `${API_PREFIX}/admin/teams` });
    await app.register(teamRoutes(opts.prisma), { prefix: `${API_PREFIX}/teams` });
    await app.register(categoryRoutes(opts.prisma), { prefix: `${API_PREFIX}/categories` });
    await app.register(technicianRoutes(opts.prisma), { prefix: `${API_PREFIX}/technician` });
    await app.register(ticketRoutes(opts.prisma), { prefix: `${API_PREFIX}/tickets` });
  }
  if (opts.extraRoutes) {
    await app.register(
      async (scope) => {
        await opts.extraRoutes!(scope);
      },
      { prefix: API_PREFIX },
    );
  }
  return app;
}
