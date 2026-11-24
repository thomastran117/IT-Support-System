import { Prisma } from '@smartdesk/db';
import type { TicketEventType } from '@smartdesk/contracts';
import { sanitizeEventDetails } from '../../domain/ticketEvents.js';
import { notificationTypeFor } from '../../domain/notifications.js';
import type { Db } from '../transaction.js';
import { recordNotification } from './notifications.js';
import { hashCorrelationId, insertServiceEvent } from './serviceEvents.js';

export type { TicketEventType };

function serviceFact(type: TicketEventType, details: Record<string, unknown>) {
  switch (type) {
    case 'CREATED':
      return { type: 'ticket.created', payload: {} };
    case 'TEAM_ASSIGNED':
    case 'TEAM_REASSIGNED':
      return {
        type: 'ticket.routed',
        payload: { previousTeamId: details.from, teamId: details.to },
      };
    case 'STATUS_CHANGED':
    case 'RESOLVED':
    case 'REOPENED':
      return {
        type: 'ticket.status-changed',
        payload: {
          previousStatus: details.from,
          status: type === 'RESOLVED' ? 'RESOLVED' : type === 'REOPENED' ? 'OPEN' : details.to,
        },
      };
    case 'COMMENT_ADDED':
      return details.isInternal === false
        ? { type: 'ticket.public-reply', payload: { commentId: details.commentId } }
        : null;
    default:
      return null;
  }
}

/**
 * Append an audit event. `occurred_at` uses `clock_timestamp()` (not the transaction start time) so
 * several events written in one transaction keep their order when sorted by (occurred_at, event_id).
 * `actorId = null` records a system action. This is the only place events are written: details are
 * reduced to the allow-listed keys for the type (ids, statuses, flags), so secrets and private text
 * cannot be stored whatever the caller passes.
 *
 * A meaningful event also records the requester's in-app notification (SD-040) in the same
 * transaction, as well as the service event for supported ticket facts. Returns the audit event id.
 */
export async function appendEvent(
  db: Db,
  event: {
    ticketId: string;
    actorId: string | null;
    type: TicketEventType;
    details?: Record<string, unknown>;
    correlationId?: string;
  },
): Promise<string> {
  const details = sanitizeEventDetails(event.type, event.details);
  const [audit] = await db.$queryRaw<
    { id: string; occurredAt: Date; version: number; requesterId: string }[]
  >(Prisma.sql`
    WITH appended AS (
      INSERT INTO ticket_events (ticket_id, actor_id, event_type, details, occurred_at)
      VALUES (${event.ticketId}::uuid, ${event.actorId}::uuid, ${event.type},
              ${JSON.stringify(details)}::jsonb, clock_timestamp())
      RETURNING event_id, ticket_id, occurred_at
    )
    SELECT a.event_id AS id, a.occurred_at AS "occurredAt",
           t.version, t.requester_id AS "requesterId"
    FROM appended a JOIN tickets t ON t.ticket_id = a.ticket_id`);
  const eventId = audit!.id;
  const type = notificationTypeFor(event.type, details);
  const notified =
    type &&
    (await recordNotification(db, {
      eventId,
      ticketId: event.ticketId,
      actorId: event.actorId,
      type,
    }));
  const fact = serviceFact(event.type, details);
  if (fact) {
    await insertServiceEvent(db, {
      schemaVersion: 1,
      eventId,
      type: fact.type,
      occurredAt: audit!.occurredAt.toISOString(),
      aggregateId: event.ticketId,
      aggregateVersion: audit!.version,
      correlationId: event.correlationId ? hashCorrelationId(event.correlationId) : eventId,
      payload: {
        ...fact.payload,
        ...(notified ? { notification: { recipientId: audit!.requesterId, type } } : {}),
      },
    });
  }
  return eventId;
}

export const listEvents = (db: Db, ticketId: string) =>
  db.ticketEvent.findMany({ where: { ticketId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
