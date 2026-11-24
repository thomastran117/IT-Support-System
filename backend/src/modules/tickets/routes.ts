import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import type { ReviewResultDto, TicketCommentDto, TicketStatus } from '@smartdesk/contracts';
import {
  IDEMPOTENCY_KEY_HEADER,
  approveRoutingSchema,
  createCommentSchema,
  createTicketSchema,
  reviewRecommendationSchema,
  TICKET_PAGE_SIZE_DEFAULT,
  TICKET_PAGE_SIZE_MAX,
  transitionSchema,
} from '@smartdesk/contracts';
import { z } from 'zod';
import { authorizeTicket } from '../../auth/ticketAccess.js';
import {
  addComment,
  approveRouting,
  reviewRecommendation,
  submitTicket,
  transitionTicket,
} from '../../db/services/ticketService.js';
import { HttpError, envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';
import { toTicketDto } from './dto.js';
import { getAnalysisStatus, requestAnalysis } from './analysis.js';
import { listTicketRecommendations } from './recommendations.js';
import { getTicketDetail, listTicketComments, listTicketEvents, listTickets } from './queries.js';

const ListQuery = z.strictObject({
  status: z.enum(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
  priority: z.enum(['UNSET', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  limit: z.coerce.number().int().min(1).max(TICKET_PAGE_SIZE_MAX).default(TICKET_PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Strict: author and timestamps are server-assigned, never accepted from the client. */
const CommentBody = createCommentSchema;

const TransitionBody = transitionSchema;

/**
 * Strict: unknown fields (role, requesterId, status, assignee, team...) are rejected rather than
 * ignored, so an employee cannot smuggle in routing or ownership.
 */
const CreateBody = createTicketSchema;

/** Printable ASCII, 8-100 chars (UUIDs and similar random tokens). */
const IdempotencyKey = z
  .string()
  .regex(/^[\x21-\x7e]{8,100}$/, 'Idempotency-Key must be 8-100 printable characters');

/** Mounted under /api/tickets. */
export const ticketRoutes =
  (
    prisma: PrismaClient,
    analysis?: { maxAttempts: number },
    aiAnalysisRateLimit: { max: number; windowMs: number } = { max: 10, windowMs: 60_000 },
    outboxNotifications = false,
  ): FastifyPluginAsync =>
  async (app) => {
    const auth = { preHandler: app.authGuards.requireAuth };
    // Keyed by account, not IP: the endpoint is only reachable once authenticated, and a shared
    // IP (NAT, office network) should not share one budget across unrelated accounts. Runs as a
    // preHandler, after `requireAuth` above has populated req.principal.
    const aiAnalysisLimit = {
      config: {
        rateLimit: {
          max: aiAnalysisRateLimit.max,
          timeWindow: aiAnalysisRateLimit.windowMs,
          hook: 'preHandler' as const,
          keyGenerator: (req: FastifyRequest) => `user:${req.principal!.id}`,
        },
      },
    };

    app.post('/', auth, async (req, reply) => {
      const body = parse(CreateBody, req.body);
      const header = req.headers[IDEMPOTENCY_KEY_HEADER];
      const idempotencyKey = header === undefined ? undefined : parse(IdempotencyKey, header);

      // The requester is always the authenticated user. When AI is enabled the analysis job is
      // queued in the same transaction (a durable outbox) and a worker runs it later, so the
      // provider's latency or failure never blocks or fails the submission.
      const { ticket, created } = await submitTicket(prisma, {
        outboxNotifications,
        correlationId: req.id,
        requesterId: req.principal!.id,
        ...body,
        idempotencyKey,
        ...(analysis ? { enqueueAnalysis: analysis } : {}),
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

    app.get('/:id/events', auth, async (req) => {
      const { id } = req.params as { id: string };
      const scope = await authorizeTicket(prisma, req.principal!, id, 'read');
      return envelope('Timeline', await listTicketEvents(prisma, req.principal!, scope));
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
        outboxNotifications,
        correlationId: req.id,
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
        outboxNotifications,
        correlationId: req.id,
        ticketId: id,
        actorId: req.principal!.id,
        to: body.to as TicketStatus,
        expectedVersion: body.expectedVersion,
        resolutionSummary: body.resolutionSummary,
      });
      reply.header('cache-control', 'no-store');
      return envelope('Ticket updated', toTicketDto(ticket));
    });

    app.post('/:id/routing', auth, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parse(approveRoutingSchema, req.body);
      // 404 for unknown or unreadable tickets, 403 for readers who may not edit (the requester,
      // technicians outside the ticket's team). The service re-checks inside its transaction.
      await authorizeTicket(prisma, req.principal!, id, 'edit');
      const ticket = await approveRouting(prisma, {
        outboxNotifications,
        correlationId: req.id,
        ticketId: id,
        actorId: req.principal!.id,
        categoryId: body.categoryId,
        priority: body.priority,
        teamId: body.teamId,
        // Omitted keeps the current assignee when the team is unchanged (and clears it on a team
        // change); an explicit null clears it.
        assigneeId: body.assigneeId,
        expectedVersion: body.expectedVersion,
      });
      reply.header('cache-control', 'no-store');
      return envelope('Routing approved', toTicketDto(ticket));
    });

    app.get('/:id/analysis', auth, async (req, reply) => {
      const { id } = req.params as { id: string };
      // Staff only, like the recommendations themselves (404 unreadable, 403 requester).
      await authorizeTicket(prisma, req.principal!, id, 'edit');
      reply.header('cache-control', 'no-store');
      return envelope(
        'Analysis status',
        await getAnalysisStatus(prisma, id, { enabled: !!analysis }),
      );
    });

    app.post('/:id/analysis', { ...auth, ...aiAnalysisLimit }, async (req, reply) => {
      const params = parse(z.object({ id: z.string() }), req.params);
      const body = parse(z.strictObject({ requestId: z.uuid().optional() }), req.body ?? {});
      await authorizeTicket(prisma, req.principal!, params.id, 'edit');
      reply.header('cache-control', 'no-store');
      if (!analysis) {
        // Nothing is queued and nothing fails: manual triage carries on as usual.
        throw new HttpError(409, 'AI analysis is not enabled', { code: 'AI_DISABLED' });
      }
      const { created } = await requestAnalysis(prisma, {
        correlationId: req.id,
        ticketId: params.id,
        ...(body.requestId ? { requestId: body.requestId } : {}),
        maxAttempts: analysis.maxAttempts,
      });
      const status = await getAnalysisStatus(prisma, params.id, { enabled: true });
      return reply
        .code(created ? 202 : 200)
        .send(envelope(created ? 'Analysis requested' : 'Analysis already requested', status));
    });

    app.get('/:id/recommendations', auth, async (req, reply) => {
      const { id } = req.params as { id: string };
      // AI output is for staff working the ticket: 404 when the ticket is unreadable, 403 for the
      // requester (who can read the ticket but never sees recommendations).
      await authorizeTicket(prisma, req.principal!, id, 'edit');
      reply.header('cache-control', 'no-store');
      return envelope('Recommendations', await listTicketRecommendations(prisma, id));
    });

    app.post('/:id/recommendations/:recommendationId/review', auth, async (req, reply) => {
      const params = parse(z.object({ id: z.string(), recommendationId: z.uuid() }), req.params);
      const body = parse(reviewRecommendationSchema, req.body);
      // 404 for tickets the caller cannot read, 403 for readers who may not edit (requesters).
      await authorizeTicket(prisma, req.principal!, params.id, 'edit');
      const result = await reviewRecommendation(prisma, {
        outboxNotifications,
        correlationId: req.id,
        recommendationId: params.recommendationId,
        // The recommendation must belong to the ticket in the URL; the reviewer is the caller.
        ticketId: params.id,
        reviewerId: req.principal!.id,
        decision: body.decision,
        notes: body.notes || undefined,
        override: body.override,
        expectedVersion: body.expectedVersion,
      });
      const dto: ReviewResultDto = {
        ticket: toTicketDto(result.ticket),
        recommendationId: result.recommendationId,
        decision: result.decision,
      };
      reply.header('cache-control', 'no-store');
      return envelope('Recommendation reviewed', dto);
    });
  };
