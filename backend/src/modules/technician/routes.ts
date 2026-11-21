import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import {
  TICKET_PAGE_SIZE_DEFAULT,
  TICKET_PAGE_SIZE_MAX,
  type QueueItemDto,
  type QueuePage,
  type TicketPriority,
  type TicketStatus,
} from '@smartdesk/contracts';
import { z } from 'zod';
import {
  countTeamQueue,
  countUnassignedBacklog,
  listTeamQueue,
  listUnassignedBacklog,
  type BacklogRow,
  type QueueFilter,
  type QueueRow,
} from '../../db/repositories/operationalQueries.js';
import { HttpError, envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';

const STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['UNSET', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/** Comma-separated enum list (`?priority=CRITICAL,HIGH`), de-duplicated and bounded. */
const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((v) => [...new Set(v.split(',').map((x) => x.trim()))])
    .pipe(z.array(z.enum(values)).min(1).max(values.length))
    .optional();

const date = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

const common = {
  priority: csv(PRIORITIES),
  categoryId: z.uuid().optional(),
  createdFrom: date.optional(),
  createdTo: date.optional(),
  sort: z.enum(['priority', 'age']).optional(),
  limit: z.coerce.number().int().min(1).max(TICKET_PAGE_SIZE_MAX).default(TICKET_PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
};

const rangeOk = (q: { createdFrom?: Date; createdTo?: Date }) =>
  !q.createdFrom || !q.createdTo || q.createdFrom < q.createdTo;
const rangeError = { message: 'createdFrom must be before createdTo', path: ['createdFrom'] };

/** Strict: an unknown filter is an error, not silently ignored. */
const TeamQueueQuery = z
  .strictObject({
    teamId: z.uuid(),
    status: csv(STATUSES),
    mine: z.enum(['true', 'false']).optional(),
    ...common,
  })
  .refine(rangeOk, rangeError);

const BacklogQuery = z.strictObject(common).refine(rangeOk, rangeError);

const named = (id: string | null, name: string | null) => (id && name ? { id, name } : null);

const toItem = (r: QueueRow | BacklogRow): QueueItemDto => ({
  id: r.ticketId,
  title: r.title,
  status: r.status as TicketStatus,
  priority: r.priority as TicketPriority,
  category: named(r.categoryId, r.categoryName),
  assignee: 'assigneeId' in r ? named(r.assigneeId, r.assigneeName) : null,
  createdAt: r.createdAt.toISOString(),
  ageMinutes: Math.max(0, Math.round(r.ageMinutes)),
  version: r.version,
});

const toPage = (
  items: QueueItemDto[],
  total: number,
  limit: number,
  offset: number,
): QueuePage => ({
  items,
  total,
  limit,
  offset,
  nextOffset: offset + items.length < total ? offset + items.length : null,
});

/**
 * Technician triage queues (Q02/Q03). Mounted under /api/technician. Staff only; scope comes from
 * the authenticated principal's active team memberships, never from the request.
 */
export const technicianRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const staff = { preHandler: app.authGuards.requireRole('TECHNICIAN', 'ADMIN') };

    app.get('/queue', staff, async (req, reply) => {
      const p = req.principal!;
      const q = parse(TeamQueueQuery, req.query);
      if (p.role === 'ADMIN') {
        // 404 for an unknown team rather than an empty list that looks legitimate.
        if (!(await prisma.supportTeam.findUnique({ where: { id: q.teamId } }))) {
          throw new HttpError(404, 'Team not found');
        }
      } else if (!p.teamIds.includes(q.teamId)) {
        throw new HttpError(403, 'You are not a member of this team');
      }
      const filter: QueueFilter = {
        statuses: q.status,
        priorities: q.priority,
        categoryId: q.categoryId,
        createdFrom: q.createdFrom,
        createdTo: q.createdTo,
        assigneeId: q.mine === 'true' ? p.id : undefined,
      };
      const [rows, total] = await Promise.all([
        listTeamQueue(prisma, p.id, q.teamId, q, filter, q.sort ?? 'priority'),
        countTeamQueue(prisma, p.id, q.teamId, filter),
      ]);
      reply.header('cache-control', 'no-store');
      return envelope('Team queue', toPage(rows.map(toItem), total, q.limit, q.offset));
    });

    app.get('/unassigned', staff, async (req, reply) => {
      const p = req.principal!;
      // The shared backlog is for triagers: administrators, and technicians on an active team.
      if (p.role === 'TECHNICIAN' && p.teamIds.length === 0) {
        throw new HttpError(403, 'Join a support team to triage the unassigned backlog');
      }
      const q = parse(BacklogQuery, req.query);
      const filter: QueueFilter = {
        priorities: q.priority,
        categoryId: q.categoryId,
        createdFrom: q.createdFrom,
        createdTo: q.createdTo,
      };
      const [rows, total] = await Promise.all([
        listUnassignedBacklog(prisma, p.id, q, filter, q.sort ?? 'age'),
        countUnassignedBacklog(prisma, p.id, filter),
      ]);
      reply.header('cache-control', 'no-store');
      return envelope('Unassigned backlog', toPage(rows.map(toItem), total, q.limit, q.offset));
    });
  };
