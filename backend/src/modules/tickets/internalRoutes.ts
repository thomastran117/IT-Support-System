import type { FastifyContextConfig, FastifyPluginAsync, preHandlerAsyncHookHandler } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import { authorizeTicket } from '../../auth/ticketAccess.js';
import { HttpError } from '../../plugins/errors.js';

// The CORS plugin reads this opt-out from the route config at runtime.
const privateRoute: FastifyContextConfig & { cors: false } = { cors: false };

export const internalTicketRoutes =
  (prisma: PrismaClient, requireWorkAccessCaller: preHandlerAsyncHookHandler): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });
    app.get<{ Params: { id: string } }>(
      '/:id/work-access',
      { config: privateRoute, exposeHeadRoute: false, preHandler: requireWorkAccessCaller },
      async (req, reply) => {
        const actor = req.internalActor;
        if (actor?.kind !== 'user') throw new HttpError(403, 'Delegated user required');
        await authorizeTicket(prisma, actor.principal, req.params.id, 'edit');
        return reply.code(204).send();
      },
    );
    app.options('/:id/work-access', { config: privateRoute }, (_req, reply) =>
      reply.callNotFound(),
    );
  };
