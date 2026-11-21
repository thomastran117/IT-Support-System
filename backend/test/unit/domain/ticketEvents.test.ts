import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TICKET_EVENT_TYPES,
  isTicketEventType,
  sanitizeEventDetails,
  toTimelineEntry,
  type StoredEvent,
} from '../../../src/domain/ticketEvents.js';

const ID = '00000001-0000-4000-8000-000000000005';
const ID2 = '00000001-0000-4000-8000-000000000006';

describe('sanitizeEventDetails', () => {
  it('keeps the allow-listed keys with well-formed values', () => {
    expect(sanitizeEventDetails('STATUS_CHANGED', { from: 'OPEN', to: 'TRIAGED' })).toEqual({
      from: 'OPEN',
      to: 'TRIAGED',
    });
    expect(sanitizeEventDetails('TEAM_ASSIGNED', { from: null, to: ID })).toEqual({
      from: null,
      to: ID,
    });
    expect(
      sanitizeEventDetails('COMMENT_ADDED', {
        commentId: ID,
        isInternal: true,
        firstResponse: true,
      }),
    ).toEqual({ commentId: ID, isInternal: true, firstResponse: true });
    expect(
      sanitizeEventDetails('AI_REVIEWED', { recommendationId: ID, decision: 'OVERRIDDEN' }),
    ).toEqual({ recommendationId: ID, decision: 'OVERRIDDEN' });
    expect(sanitizeEventDetails('PRIORITY_UPDATED', { from: 'UNSET', to: 'HIGH' })).toEqual({
      from: 'UNSET',
      to: 'HIGH',
    });
  });

  it('drops credentials, tokens, bodies and any other unknown key', () => {
    const dirty = {
      from: 'OPEN',
      to: 'TRIAGED',
      password: 'hunter2',
      passwordHash: '$argon2id$...',
      token: 'eyJhbGciOi',
      accessToken: 'abc',
      refreshToken: 'def',
      body: 'the whole comment text',
      description: 'the whole raw ticket body',
      title: 'Printer jams',
      authorization: 'Bearer x',
      secret: 's',
      nested: { password: 'x' },
      list: [1, 2],
    };
    const clean = sanitizeEventDetails('STATUS_CHANGED', dirty);
    expect(clean).toEqual({ from: 'OPEN', to: 'TRIAGED' });
    const text = JSON.stringify(clean);
    for (const word of ['hunter2', 'argon2', 'eyJ', 'comment text', 'raw ticket', 'Bearer']) {
      expect(text).not.toContain(word);
    }
  });

  it('drops allowed keys whose values are malformed', () => {
    expect(sanitizeEventDetails('STATUS_CHANGED', { from: 'DONE', to: 'x'.repeat(5000) })).toEqual(
      {},
    );
    expect(sanitizeEventDetails('TEAM_ASSIGNED', { from: 'not-a-uuid', to: { id: ID } })).toEqual(
      {},
    );
    expect(sanitizeEventDetails('COMMENT_ADDED', { commentId: ID, isInternal: 'yes' })).toEqual({
      commentId: ID,
    });
    expect(
      sanitizeEventDetails('AI_REVIEWED', { recommendationId: ID, decision: 'MAYBE' }),
    ).toEqual({ recommendationId: ID });
  });

  it('gives an event type with no details an empty object whatever is passed', () => {
    expect(sanitizeEventDetails('CREATED', { description: 'whole body', from: 'OPEN' })).toEqual(
      {},
    );
  });

  it('survives hostile and degenerate input', () => {
    for (const bad of [null, undefined, 'text', 42, [], [{ from: 'OPEN' }], true]) {
      expect(sanitizeEventDetails('STATUS_CHANGED', bad)).toEqual({});
    }
    const polluted = JSON.parse('{"__proto__": {"from": "OPEN"}, "to": "CLOSED"}');
    expect(sanitizeEventDetails('STATUS_CHANGED', polluted)).toEqual({ to: 'CLOSED' });
    expect(({} as Record<string, unknown>).from).toBeUndefined();
  });

  it('returns nothing for an unknown event type', () => {
    expect(sanitizeEventDetails('DELETED', { from: 'OPEN' })).toEqual({});
    expect(isTicketEventType('DELETED')).toBe(false);
    expect(TICKET_EVENT_TYPES.every(isTicketEventType)).toBe(true);
  });
});

describe('toTimelineEntry', () => {
  const stored = (eventType: string, details: unknown, actor = true): StoredEvent => ({
    id: ID2,
    eventType,
    occurredAt: new Date('2026-01-01T10:00:00.000Z'),
    details,
    actor: actor ? { id: ID, displayName: 'Tara Technician' } : null,
  });

  it('gives staff the actor and the sanitized details', () => {
    expect(
      toTimelineEntry(
        stored('STATUS_CHANGED', { from: 'OPEN', to: 'TRIAGED', password: 'x' }),
        'staff',
      ),
    ).toEqual({
      id: ID2,
      type: 'STATUS_CHANGED',
      occurredAt: '2026-01-01T10:00:00.000Z',
      actor: { id: ID, name: 'Tara Technician' },
      details: { from: 'OPEN', to: 'TRIAGED' },
    });
  });

  it('shows a system action to staff with no actor', () => {
    expect(
      toTimelineEntry(stored('STATUS_CHANGED', { from: 'RESOLVED', to: 'CLOSED' }, false), 'staff'),
    ).toMatchObject({ actor: null });
  });

  it('hides internal event types from requesters', () => {
    for (const type of ['COMMENT_ADDED', 'AI_REVIEWED', 'ASSIGNEE_UPDATED']) {
      expect(
        toTimelineEntry(stored(type, { commentId: ID, isInternal: true }), 'requester'),
      ).toBeNull();
    }
  });

  it('reduces requester entries to type, time and status or priority changes, without the actor', () => {
    expect(
      toTimelineEntry(stored('STATUS_CHANGED', { from: 'OPEN', to: 'TRIAGED' }), 'requester'),
    ).toEqual({
      id: ID2,
      type: 'STATUS_CHANGED',
      occurredAt: '2026-01-01T10:00:00.000Z',
      actor: null,
      details: { from: 'OPEN', to: 'TRIAGED' },
    });
    expect(
      toTimelineEntry(stored('PRIORITY_UPDATED', { from: 'UNSET', to: 'HIGH' }), 'requester'),
    ).toMatchObject({
      details: { from: 'UNSET', to: 'HIGH' },
    });
    // Team and category changes show that they happened, not which record.
    for (const type of ['TEAM_ASSIGNED', 'TEAM_REASSIGNED', 'CATEGORY_UPDATED']) {
      expect(toTimelineEntry(stored(type, { from: null, to: ID }), 'requester')).toMatchObject({
        type,
        actor: null,
        details: null,
      });
    }
    for (const type of ['CREATED', 'RESOLVED', 'REOPENED']) {
      expect(toTimelineEntry(stored(type, { from: 'OPEN' }), 'requester')).toMatchObject({
        details: null,
      });
    }
  });

  it('ignores rows with an unknown type', () => {
    expect(toTimelineEntry(stored('SOMETHING_ELSE', {}), 'staff')).toBeNull();
  });
});

/**
 * Central writing: the audit trail is only written through `appendEvent`, which sanitizes. Any other
 * code path that inserts into ticket_events would bypass it, so this test fails on such code.
 */
describe('event writing is centralized', () => {
  const root = join(__dirname, '../../../src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
    });
  const ALLOWED = [
    ['db', 'repositories', 'ticketEvents.ts'].join(sep), // the helper itself
    ['db', 'seed', 'run.ts'].join(sep), // bulk-loads fixture rows
  ];

  it('has no other code that inserts ticket events', () => {
    const offenders = files(root)
      .filter((f) => !ALLOWED.includes(relative(root, f)))
      .filter((f) =>
        /ticket_events|ticketEvent\.(create|createMany|upsert|update|delete)/.test(
          readFileSync(f, 'utf-8'),
        ),
      )
      .map((f) => relative(root, f));
    // Reading is fine (queries use ticketEvent.findMany); writing is not.
    const writers = offenders.filter((f) =>
      /INSERT\s+INTO\s+ticket_events|ticketEvent\.(create|createMany|upsert|update|updateMany|delete|deleteMany)|UPDATE\s+ticket_events|DELETE\s+FROM\s+ticket_events/i.test(
        readFileSync(join(root, f), 'utf-8'),
      ),
    );
    expect(writers).toEqual([]);
  });
});
