import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_PREFIX } from '@smartdesk/contracts';
import type { Env } from './config/env.js';
import type { DbCheck, PrismaClient } from '@smartdesk/db';
import type { CacheCheck } from './cache/client.js';
import { createNoopCache, type CacheClient } from './cache/redisCache.js';
import type { createFallbackRateLimitStore } from './rateLimit/fallbackStore.js';
import { createAuthGuards } from './auth/guard.js';
import { TokenService } from './auth/tokens.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { registerErrorHandling } from './plugins/errors.js';
import { adminKnowledgeRoutes, knowledgeRoutes } from './modules/knowledge/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { pingRoutes } from './modules/ping.js';
import {
  adminCategoryRoutes,
  adminTeamRoutes,
  categoryRoutes,
  teamRoutes,
} from './modules/teams/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { labelListRoutes, ticketLabelRoutes } from './modules/evaluation/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { createSearchClient, type SearchClient } from './modules/search/client.js';
import { ticketSearchRoutes } from './modules/search/ticketSearchRoutes.js';
import { technicianRoutes } from './modules/technician/routes.js';
import { ticketRoutes } from './modules/tickets/routes.js';

export interface AppOptions {
  env: Env;
  checkDb: DbCheck;
  checkCache: CacheCheck;
  /** Cache-aside reads (reference data, reports). Defaults to a no-op cache, so every test that
   * omits this keeps reading fresh from Postgres exactly as before this option existed. */
  cache?: CacheClient;
  /** Database client; the auth routes are only mounted when provided. */
  prisma?: PrismaClient;
  /** Per-IP request budgets for the auth endpoints (tests lower these). */
  authRateLimit?: { login: number; refresh: number; windowMs: number };
  /** Per-account request budget for triggering AI analysis (tests lower this). */
  aiAnalysisRateLimit?: { max: number; windowMs: number };
  /** Optional OpenSearch transport and per-account search budget overrides. */
  searchClient?: SearchClient;
  ticketSearchRateLimit?: { max: number; windowMs: number };
  /** A @fastify/rate-limit store shared across backend instances (e.g. one backed by Redis).
   * Omitted entirely -- not just unconfigured -- when Redis is disabled, so the plugin falls
   * back to its own in-memory default exactly as it did before this option existed. */
  rateLimitStore?: ReturnType<typeof createFallbackRateLimitStore>;
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
  const cache = opts.cache ?? createNoopCache();
  const app = Fastify({
    logger: opts.logger ?? {
      level: opts.env.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    // false (default) never trusts a forwarded-for header, so request.ip cannot be spoofed by a
    // client; only set for a deployment that genuinely sits behind a known reverse proxy.
    trustProxy: opts.env.trustProxy,
  });

  await app.register(cors, {
    origin: opts.env.frontendOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    // @fastify/rate-limit's own `.d.ts` for a custom store's `child(routeOptions)` omits the
    // `routeInfo` field its real implementation both passes and requires (see
    // node_modules/@fastify/rate-limit/index.js's `mergeParams`); this cast bridges that gap.
    ...(opts.rateLimitStore ? { store: opts.rateLimitStore as unknown as never } : {}),
  });
  registerErrorHandling(app);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(healthRoutes(opts.checkDb, opts.checkCache));
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
    await app.register(reportRoutes(opts.prisma, cache), { prefix: `${API_PREFIX}/admin/reports` });
    await app.register(ticketLabelRoutes(opts.prisma), { prefix: `${API_PREFIX}/admin/tickets` });
    await app.register(labelListRoutes(opts.prisma), {
      prefix: `${API_PREFIX}/admin/classification-labels`,
    });
    await app.register(adminKnowledgeRoutes(opts.prisma), {
      prefix: `${API_PREFIX}/admin/knowledge`,
    });
    await app.register(knowledgeRoutes(opts.prisma), { prefix: `${API_PREFIX}/knowledge` });
    await app.register(adminTeamRoutes(opts.prisma, cache), {
      prefix: `${API_PREFIX}/admin/teams`,
    });
    await app.register(adminCategoryRoutes(opts.prisma, cache), {
      prefix: `${API_PREFIX}/admin/categories`,
    });
    await app.register(teamRoutes(opts.prisma, cache), { prefix: `${API_PREFIX}/teams` });
    await app.register(categoryRoutes(opts.prisma, cache), { prefix: `${API_PREFIX}/categories` });
    await app.register(notificationRoutes(opts.prisma), {
      prefix: `${API_PREFIX}/notifications`,
    });
    await app.register(technicianRoutes(opts.prisma), { prefix: `${API_PREFIX}/technician` });
    await app.register(
      ticketSearchRoutes({
        prisma: opts.prisma,
        client: opts.searchClient ?? createSearchClient(opts.env.openSearch),
        jwtSecret: opts.env.jwtSecret,
        rateLimit: opts.ticketSearchRateLimit ?? { max: 30, windowMs: 60_000 },
      }),
      { prefix: `${API_PREFIX}/tickets` },
    );
    await app.register(
      ticketRoutes(
        opts.prisma,
        opts.env.ai.provider === 'none'
          ? undefined
          : { maxAttempts: opts.env.ai.worker.maxAttempts },
        opts.aiAnalysisRateLimit ?? { max: 10, windowMs: 60_000 },
      ),
      { prefix: `${API_PREFIX}/tickets` },
    );
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
