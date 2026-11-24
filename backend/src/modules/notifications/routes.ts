import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import { createInboxRoutes } from '@smartdesk/notifications';
import { HttpError } from '../../plugins/errors.js';

export const notificationRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    await app.register(
      createInboxRoutes(
        prisma,
        async (req, reply) => {
          await app.authGuards.requireAuth.call(app, req, reply);
          return req.principal!.id;
        },
        (status, message, details) => new HttpError(status, message, details),
      ),
    );
  };
