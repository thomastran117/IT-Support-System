import { createReportRoutes } from '@smartdesk/analytics';
import type { PrismaClient } from '@smartdesk/db';
import type { FastifyPluginAsync } from 'fastify';
import { createCacheAside } from '../../cache/cacheAside.js';
import type { CacheClient } from '../../cache/redisCache.js';
import { reportQueries } from '../../db/repositories/reports.js';
import { HttpError } from '../../plugins/errors.js';

const REPORT_TTL_SECONDS = 30;

export const reportRoutes =
  (prisma: PrismaClient, cache: CacheClient): FastifyPluginAsync =>
  async (app) => {
    const reportsCache = createCacheAside(cache, 'reports', REPORT_TTL_SECONDS);
    const guards = app.authGuards.requireRole('ADMIN');
    await app.register(
      createReportRoutes({
        prisma,
        queries: reportQueries,
        resolveAdmin: async (req, reply) => {
          for (const guard of guards) await guard.call(app, req, reply);
          return req.principal!.id;
        },
        badRequest: (details) => new HttpError(400, 'Validation failed', details),
        read: reportsCache.read,
      }),
    );
  };
