import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_PREFIX } from '@smartdesk/contracts';
import type { Env } from './config/env.js';
import type { DbCheck } from './db/pool.js';
import { registerErrorHandling } from './plugins/errors.js';
import { healthRoutes } from './modules/health/routes.js';
import { pingRoutes } from './modules/ping.js';

export interface AppOptions {
  env: Env;
  checkDb: DbCheck;
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

  await app.register(cors, { origin: opts.env.frontendOrigin, credentials: true });
  registerErrorHandling(app);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(healthRoutes(opts.checkDb));
  await app.register(pingRoutes, { prefix: API_PREFIX });
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
