import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import type { TicketCommentDto, TicketStatus } from '@smartdesk/contracts';
import {
  IDEMPOTENCY_KEY_HEADER,
  TICKET_DESCRIPTION_MAX,
  TICKET_COMMENT_MAX,
  TICKET_PAGE_SIZE_DEFAULT,
  TICKET_PAGE_SIZE_MAX,
  TICKET_RESOLUTION_MAX,
  TICKET_TITLE_MAX,
} from '@smartdesk/contracts';
import { z } from 'zod';
import { authorizeTicket } from '../../auth/ticketAccess.js';
import { addComment, submitTicket, transitionTicket } from '../../db/services/ticketService.js';
import { TICKET_STATUSES } from '../../domain/ticketStateMachine.js';
import { HttpError, envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';
import { toTicketDto } from './dto.js';
import { getTicketDetail, listTicketComments, listTickets } from './queries.js';

const ListQuery = z.strictObject({
  status: z.enum(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
  priority: z.enum(['UNSET', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  limit: z.coerce.number().int().min(1).max(TICKET_PAGE_SIZE_MAX).default(TICKET_PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Strict: author and timestamps are server-assigned, never accepted from the client. */
const CommentBody = z.strictObject({
  body: z.string().trim().min(1).max(TICKET_COMMENT_MAX),
  isInternal: z.boolean().default(false),
});

/** Strict, and `expectedVersion` is mandatory: a transition is always made against a known view. */
const TransitionBody = z.strictObject({
  to: z.enum(TICKET_STATUSES as [string, ...string[]]),
  expectedVersion: z.number().int().min(1),
  resolutionSummary: z.string().max(TICKET_RESOLUTION_MAX).optional(),
});

/**
 * Strict: unknown fields (role, requesterId, status, assignee, team...) are rejected rather than
 * ignored, so an employee cannot smuggle in routing or ownership.
 */
const CreateBody = z.strictObject({
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX),
  description: z.string().trim().min(1).max(TICKET_DESCRIPTION_MAX),
});

/** Printable ASCII, 8-100 chars (UUIDs and similar random tokens). */
const IdempotencyKey = z
  .string()
  .regex(/^[\x21-\x7e]{8,100}$/, 'Idempotency-Key must be 8-100 printable characters');

/** Mounted under /api/tickets. */
export const ticketRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const auth = { preHandler: app.authGuards.requireAuth };

    app.post('/', auth, async (req, reply) => {
      const body = parse(CreateBody, req.body);
      const header = req.headers[IDEMPOTENCY_KEY_HEADER];
      const idempotencyKey = header === undefined ? undefined : parse(IdempotencyKey, header);

      // The requester is always the authenticated user. AI analysis, when it exists, is scheduled
      // after this commit and never blocks or fails the submission.
      const { ticket, created } = await submitTicket(prisma, {
        requesterId: req.principal!.id,
        ...body,
        idempotencyKey,
      });

      reply.header('cache-control', 'no-store');
      if (!created) {
        reply.header('idempotent-replay', 'true');
        return reply.code(200).send(envelope('Ticket already submitted', toTicketDto(ticket)));
      }
      return reply.code(201).send(envelope('Ticket created', toTicketDto(ticket)));
    });

    app.get('/', auth, async (req) =>
      envelope('Tickets', await listTickets(prisma, req.principal!, parse(ListQuery, req.query))),
    );

    app.get('/:id', auth, async (req) => {
      const { id } = req.params as { id: string };
      // 404 for unknown, malformed and unreadable ids alike, so ids cannot be probed.
      const scope = await authorizeTicket(prisma, req.principal!, id, 'read');
      const detail = await getTicketDetail(prisma, req.principal!, scope);
      if (!detail) throw new HttpError(404, 'Ticket not found');
      return envelope('Ticket', detail);
    });

    app.get('/:id/comments', auth, async (req) => {
      const { id } = req.params as { id: string };
      const scope = await authorizeTicket(prisma, req.principal!, id, 'read');
      return envelope('Comments', await listTicketComments(prisma, req.principal!, scope));
    });

    app.post('/:id/comments', auth, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parse(CommentBody, req.body);
      // 404 for tickets the caller cannot read; the service then enforces who may write what
      // (403 when an employee asks for an internal note).
      await authorizeTicket(prisma, req.principal!, id, 'read');
      const comment = await addComment(prisma, {
        ticketId: id,
        authorId: req.principal!.id,
        body: body.body,
        isInternal: body.isInternal,
      });
      const dto: TicketCommentDto = {
        id: comment.id,
        body: comment.body,
        isInternal: comment.isInternal,
        author: { id: req.principal!.id, name: req.principal!.displayName },
        createdAt: comment.createdAt.toISOString(),
      };
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(envelope('Comment added', dto));
    });

    app.post('/:id/transitions', auth, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parse(TransitionBody, req.body);
      // Unreadable or unknown tickets are 404. The service then decides who may do what: staff in
      // scope for every edge, the requester for reopening only (403 otherwise).
      await authorizeTicket(prisma, req.principal!, id, 'read');
      const ticket = await transitionTicket(prisma, {
        ticketId: id,
        actorId: req.principal!.id,
        to: body.to as TicketStatus,
        expectedVersion: body.expectedVersion,
        resolutionSummary: body.resolutionSummary,
      });
      reply.header('cache-control', 'no-store');
      return envelope('Ticket updated', toTicketDto(ticket));
    });
  };
