import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import {
  IDEMPOTENCY_KEY_HEADER,
  TICKET_DESCRIPTION_MAX,
  TICKET_TITLE_MAX,
} from '@smartdesk/contracts';
import { z } from 'zod';
import { submitTicket } from '../../db/services/ticketService.js';
import { envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';
import { toTicketDto } from './dto.js';

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
  };
