import type { FastifyPluginAsync } from 'fastify';
import type { LiveHealth, ReadyHealth } from '@smartdesk/contracts';
import type { DbCheck } from '../../db/pool.js';

export const healthRoutes =
  (checkDb: DbCheck): FastifyPluginAsync =>
  async (app) => {
    app.get('/health/live', async (): Promise<LiveHealth> => ({ status: 'ok' }));

    app.get('/health/ready', async (_req, reply): Promise<ReadyHealth> => {
      const dbOk = await checkDb();
      if (!dbOk) reply.code(503);
      return {
        status: dbOk ? 'ok' : 'unavailable',
        checks: { database: dbOk ? 'ok' : 'unavailable' },
      };
    });
  };
