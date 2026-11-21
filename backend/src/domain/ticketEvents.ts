import type { TicketEventType, TicketPriority, TicketStatus } from '@smartdesk/contracts';
import { TICKET_EVENT_TYPES } from '@smartdesk/contracts';

/**
 * The audit timeline rules (SD-022), as pure data and functions.
 *
 *  - {@link sanitizeEventDetails} runs on every write (the one `appendEvent` helper) and again on
 *    every read, so stored details can only ever hold the allow-listed keys with well-formed values:
 *    ids, statuses, priorities and flags. Free text, ticket bodies, comment text, credentials and
 *    tokens have no way in, whatever a caller passes.
 *  - {@link visibleToRequester} decides what a requester's timeline shows.
 *
 * Adding an event type means: extend `TICKET_EVENT_TYPES` in packages/contracts, add a migration for
 * the `ck_ticket_events_type` CHECK, and describe its details here (a test fails until all three
 * agree). See docs/api.md for the public timeline behavior.
 */
export { TICKET_EVENT_TYPES };
export type { TicketEventType };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly TicketStatus[] = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const PRIORITIES: readonly TicketPriority[] = ['UNSET', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const DECISIONS = ['ACCEPTED', 'OVERRIDDEN', 'REJECTED'] as const;

type Rule = (v: unknown) => boolean;
const uuid: Rule = (v) => typeof v === 'string' && UUID.test(v);
const uuidOrNull: Rule = (v) => v === null || uuid(v);
const oneOf =
  (values: readonly string[]): Rule =>
  (v) =>
    typeof v === 'string' && values.includes(v);
const bool: Rule = (v) => typeof v === 'boolean';

const status = oneOf(STATUSES);
const priority = oneOf(PRIORITIES);

/** Allowed detail keys per event type, and the shape of each value. */
const DETAILS: Record<TicketEventType, Record<string, Rule>> = {
  CREATED: {},
  STATUS_CHANGED: { from: status, to: status },
  RESOLVED: { from: status },
  REOPENED: { from: status },
  TEAM_ASSIGNED: { from: uuidOrNull, to: uuidOrNull },
  TEAM_REASSIGNED: { from: uuidOrNull, to: uuidOrNull },
  CATEGORY_UPDATED: { from: uuidOrNull, to: uuidOrNull },
  PRIORITY_UPDATED: { from: priority, to: priority },
  ASSIGNEE_UPDATED: { from: uuidOrNull, to: uuidOrNull },
  COMMENT_ADDED: { commentId: uuid, isInternal: bool, firstResponse: bool },
  AI_REVIEWED: { recommendationId: uuid, decision: oneOf(DECISIONS) },
};

export const isTicketEventType = (value: string): value is TicketEventType =>
  (TICKET_EVENT_TYPES as readonly string[]).includes(value);

/**
 * Keep only the allow-listed keys of `type` whose values are well formed; drop everything else
 * silently. Anything that is not a plain object yields `{}`.
 */
export function sanitizeEventDetails(type: string, details: unknown): Record<string, unknown> {
  if (!isTicketEventType(type)) return {};
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {};
  const rules = DETAILS[type];
  const source = details as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(rules)) {
    if (Object.hasOwn(source, key) && rules[key]!(source[key])) clean[key] = source[key];
  }
  return clean;
}

/**
 * What a requester's timeline shows. A type that is absent is hidden entirely; for a visible type,
 * only the listed detail keys are shown. Comments are hidden (the conversation already carries the
 * public ones, and an event would reveal that an internal note exists), as are AI review decisions
 * and assignee changes (internal staffing). Team and category changes show that they happened but
 * not which record.
 */
const REQUESTER_VISIBLE: Partial<Record<TicketEventType, readonly string[]>> = {
  CREATED: [],
  STATUS_CHANGED: ['from', 'to'],
  RESOLVED: [],
  REOPENED: [],
  TEAM_ASSIGNED: [],
  TEAM_REASSIGNED: [],
  CATEGORY_UPDATED: [],
  PRIORITY_UPDATED: ['from', 'to'],
};

export type TimelineAudience = 'staff' | 'requester';

export interface StoredEvent {
  id: string;
  eventType: string;
  occurredAt: Date;
  details: unknown;
  actor: { id: string; displayName: string } | null;
}

/** Shape one stored event for an audience, or null when that audience must not see it. */
export function toTimelineEntry(e: StoredEvent, audience: TimelineAudience) {
  if (!isTicketEventType(e.eventType)) return null;
  const details = sanitizeEventDetails(e.eventType, e.details);
  if (audience === 'staff') {
    return {
      id: e.id,
      type: e.eventType,
      occurredAt: e.occurredAt.toISOString(),
      actor: e.actor ? { id: e.actor.id, name: e.actor.displayName } : null,
      details,
    };
  }
  const visibleKeys = REQUESTER_VISIBLE[e.eventType];
  if (!visibleKeys) return null;
  const shown = Object.fromEntries(
    Object.entries(details).filter(([k]) => visibleKeys.includes(k)),
  );
  return {
    id: e.id,
    type: e.eventType,
    occurredAt: e.occurredAt.toISOString(),
    actor: null,
    details: Object.keys(shown).length > 0 ? shown : null,
  };
}
