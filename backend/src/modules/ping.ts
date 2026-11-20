import type { FastifyPluginAsync } from 'fastify';
import { envelope } from '../plugins/errors.js';

// Sample module mounted under /api; real feature modules follow the same shape.
export const pingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ping', async () => envelope('pong', { time: new Date().toISOString() }));

  app.post(
    '/echo',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req) => envelope('echo', { text: (req.body as { text: string }).text }),
  );
};
