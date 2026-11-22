import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import {
  NOTIFICATION_TYPES,
  TICKET_PAGE_SIZE_DEFAULT,
  TICKET_PAGE_SIZE_MAX,
  type NotificationDto,
  type NotificationPage,
  type NotificationReadResult,
  type NotificationType,
} from '@smartdesk/contracts';
import { z } from 'zod';
import { notificationMessage } from '../../domain/notificationMessages.js';
import {
  countInbox,
  listInbox,
  markAllRead,
  markRead,
  type InboxRow,
} from '../../db/repositories/notificationInbox.js';
import { HttpError, envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';

const ListQuery = z.strictObject({
  unreadOnly: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(TICKET_PAGE_SIZE_MAX).default(TICKET_PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const IdParams = z.object({ id: z.uuid() });

const toDto = (r: InboxRow): NotificationDto => {
  const type = r.type as NotificationType;
  if (!NOTIFICATION_TYPES.includes(type)) throw new Error('Unknown notification type');
  return {
    id: r.id,
    type,
    message: notificationMessage(type),
    ticketId: r.ticketId,
    trackingId: r.ticketId,
    ticketTitle: r.ticketTitle,
    read: r.readAt !== null,
    readAt: r.readAt ? r.readAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
};

/**
 * The signed-in user's own notifications, mounted under /api/notifications. The recipient is always
 * the authenticated principal; there is no way to name another user. Someone else's id is a 404.
 */
export const notificationRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const auth = { preHandler: app.authGuards.requireAuth };

    app.get('/', auth, async (req, reply) => {
      const me = req.principal!.id;
      const q = parse(ListQuery, req.query);
      const unreadOnly = q.unreadOnly === 'true';
      const [rows, total, unreadCount] = await Promise.all([
        listInbox(prisma, me, { unreadOnly, limit: q.limit, offset: q.offset }),
        countInbox(prisma, me, unreadOnly),
        unreadOnly ? undefined : countInbox(prisma, me, true),
      ]);
      const page: NotificationPage = {
        items: rows.map(toDto),
        total,
        limit: q.limit,
        offset: q.offset,
        nextOffset: q.offset + rows.length < total ? q.offset + rows.length : null,
        unreadCount: unreadCount ?? total,
      };
      reply.header('cache-control', 'no-store');
      return envelope('Notifications', page);
    });

    app.patch('/:id/read', auth, async (req, reply) => {
      const me = req.principal!.id;
      const { id } = parse(IdParams, req.params);
      if (!(await markRead(prisma, me, id))) throw new HttpError(404, 'Notification not found');
      const result: NotificationReadResult = { unreadCount: await countInbox(prisma, me, true) };
      reply.header('cache-control', 'no-store');
      return envelope('Notification marked read', result);
    });

    app.post('/read-all', auth, async (req, reply) => {
      const me = req.principal!.id;
      const updated = await markAllRead(prisma, me);
      const result: NotificationReadResult = {
        unreadCount: await countInbox(prisma, me, true),
        updated,
      };
      reply.header('cache-control', 'no-store');
      return envelope('Notifications marked read', result);
    });
  };
