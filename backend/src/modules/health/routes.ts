import type { FastifyPluginAsync } from 'fastify';
import type { LiveHealth, ReadyHealth } from '@smartdesk/contracts';
import type { DbCheck } from '@smartdesk/db';
import type { CacheCheck } from '../../cache/client.js';

export const healthRoutes =
  (checkDb: DbCheck, checkCache: CacheCheck): FastifyPluginAsync =>
  async (app) => {
    app.get('/health/live', async (): Promise<LiveHealth> => ({ status: 'ok' }));

    app.get('/health/ready', async (_req, reply): Promise<ReadyHealth> => {
      const [dbOk, cacheStatus] = await Promise.all([checkDb(), checkCache()]);
      if (!dbOk) reply.code(503);
      return {
        status: dbOk ? 'ok' : 'unavailable',
        checks: { database: dbOk ? 'ok' : 'unavailable', cache: cacheStatus },
      };
    });
  };
