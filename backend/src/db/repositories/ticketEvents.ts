import { Prisma } from '@smartdesk/db';
import type { TicketEventType } from '@smartdesk/contracts';
import { insertInboxNotification } from '@smartdesk/notifications';
import { sanitizeEventDetails } from '../../domain/ticketEvents.js';
import { notificationTypeFor } from '../../domain/notifications.js';
import type { Db } from '../transaction.js';
import { findNotificationRecipient } from './notifications.js';
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
 * Eligible service events carry the recipient decision in the Ticket transaction. Local mode also
 * writes the inbox row in that transaction. Returns the audit event ID.
 */
export async function appendEvent(
  db: Db,
  event: {
    ticketId: string;
    actorId: string | null;
    type: TicketEventType;
    details?: Record<string, unknown>;
  } & TicketEventContext,
): Promise<string> {
  const details = sanitizeEventDetails(event.type, event.details);
  const [audit] = await db.$queryRaw<
    { id: string; occurredAt: Date; version: number }[]
  >(Prisma.sql`
    WITH appended AS (
      INSERT INTO ticket_events (ticket_id, actor_id, event_type, details, occurred_at)
      VALUES (${event.ticketId}::uuid, ${event.actorId}::uuid, ${event.type},
              ${JSON.stringify(details)}::jsonb, clock_timestamp())
      RETURNING event_id, ticket_id, occurred_at
    )
    SELECT a.event_id AS id, a.occurred_at AS "occurredAt", t.version
    FROM appended a JOIN tickets t ON t.ticket_id = a.ticket_id`);
  const eventId = audit!.id;
  const type = notificationTypeFor(event.type, details);
  const recipientId = type && (await findNotificationRecipient(db, event.ticketId, event.actorId));
  const notification = type && recipientId ? { recipientId, type } : null;
  if (notification && !event.outboxNotifications) {
    await insertInboxNotification(db, { ...notification, eventId, ticketId: event.ticketId });
  }
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
        ...(notification ? { notification } : {}),
      },
    });
  }
  return eventId;
}

export interface TicketEventContext {
  correlationId?: string;
  outboxNotifications?: boolean;
}

export const listEvents = (db: Db, ticketId: string) =>
  db.ticketEvent.findMany({ where: { ticketId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
