import { createHmac } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { z } from 'zod';
import {
  ticketSearchFallbackReasonSchema,
  ticketSearchQuerySchema,
  type TicketSearchResponse,
} from '@smartdesk/contracts';
import type { PrismaClient } from '@smartdesk/db';
import { isTicketId } from '../../auth/ticketAccess.js';
import { envelope, HttpError } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';
import type { SearchClient } from './client.js';
import { createTicketSearchService } from './ticketSearch.js';

const cursorType = 'smartdesk-ticket-search-cursor';
const positionSchema = z.tuple([z.number().nonnegative(), z.guid()]);
const cursorSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('opensearch'), position: positionSchema }),
  z.object({
    source: z.literal('postgres'),
    position: positionSchema,
    reason: ticketSearchFallbackReasonSchema,
  }),
]);

/** Mounted under /api/tickets. */
export const ticketSearchRoutes =
  (options: {
    prisma: PrismaClient;
    client?: SearchClient;
    jwtSecret: string;
    rateLimit: { max: number; windowMs: number };
  }): FastifyPluginAsync =>
  async (app) => {
    const service = createTicketSearchService(options.prisma, options.client);
    app.get(
      '/search',
      {
        preHandler: app.authGuards.requireAuth,
        config: {
          rateLimit: {
            max: options.rateLimit.max,
            timeWindow: options.rateLimit.windowMs,
            hook: 'preHandler',
            keyGenerator: (req: FastifyRequest) => `user:${req.principal!.id}`,
          },
        },
        logSerializers: {
          req: (req: FastifyRequest) => ({ method: req.method, url: req.url.split('?')[0] }),
        },
      },
      async (req, reply) => {
        reply.header('cache-control', 'no-store');
        const principal = req.principal!;
        const { q, limit, sort, cursor, createdTo, ...queryFilters } = parse(
          ticketSearchQuerySchema,
          req.query,
        );
        const filters = { ...queryFilters, createdBefore: createdTo };
        if (isTicketId(q)) {
          if (cursor) throw new HttpError(400, 'Invalid ticket search cursor');
          const page: TicketSearchResponse = {
            mode: 'exact',
            consistency: 'current',
            items: await service.lookup(principal, q, filters),
            nextCursor: null,
          };
          return envelope('Ticket search', page);
        }

        // Derive a separate key per caller scope and normalized query. The encrypted position stays
        // private and can only continue that same search, including its original page size.
        const key = createHmac('sha256', options.jwtSecret)
          .update(cursorType)
          .update(
            JSON.stringify([
              principal.id,
              principal.role,
              [...principal.teamIds].sort(),
              q,
              sort,
              limit,
              filters,
            ]),
          )
          .digest();
        let after;
        if (cursor) {
          try {
            const { payload } = await jwtDecrypt(cursor, key, {
              keyManagementAlgorithms: ['dir'],
              contentEncryptionAlgorithms: ['A256GCM'],
              typ: cursorType,
              requiredClaims: ['exp'],
            });
            // Cursors issued before fallback support belong to OpenSearch.
            after = cursorSchema.parse({ source: 'opensearch', ...payload });
          } catch {
            throw new HttpError(400, 'Invalid or expired ticket search cursor');
          }
        }
        const { nextCursor, ...result } = await service.searchText(principal, {
          text: q,
          filters,
          limit,
          after,
        });
        if (result.mode === 'fallback' && !after) {
          req.log.info({ reason: result.reason }, 'Ticket search using PostgreSQL');
        }
        const cursorPayload =
          result.mode === 'fallback'
            ? { source: 'postgres', position: nextCursor, reason: result.reason }
            : { source: 'opensearch', position: nextCursor };
        const page: TicketSearchResponse = {
          ...result,
          nextCursor: nextCursor
            ? await new EncryptJWT(cursorPayload)
                .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: cursorType })
                .setExpirationTime('10m')
                .encrypt(key)
            : null,
        };
        return envelope('Ticket search', page);
      },
    );
  };
