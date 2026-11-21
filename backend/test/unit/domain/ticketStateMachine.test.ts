import { describe, expect, it } from 'vitest';
import type { TicketStatus } from '@smartdesk/contracts';
import {
  ALLOWED_TRANSITIONS,
  TICKET_STATUSES,
  evaluateTransition,
  isAllowedTransition,
  missingPrerequisites,
  type TransitionFacts,
} from '../../../src/domain/ticketStateMachine.js';

const READY: TransitionFacts = {
  status: 'OPEN',
  categoryId: 'cat',
  priority: 'HIGH',
  teamId: 'team',
  teamActive: true,
  assigneeId: null,
  assigneeEligible: false,
  currentSummary: null,
};
const facts = (over: Partial<TransitionFacts>): TransitionFacts => ({ ...READY, ...over });

/** The complete, hand-written edge list. Everything else must be rejected. */
const EDGES: Array<[TicketStatus, TicketStatus]> = [
  ['OPEN', 'TRIAGED'],
  ['TRIAGED', 'IN_PROGRESS'],
  ['IN_PROGRESS', 'RESOLVED'],
  ['RESOLVED', 'CLOSED'],
  ['RESOLVED', 'OPEN'],
  ['CLOSED', 'OPEN'],
];

describe('ticket state machine', () => {
  describe('transition matrix', () => {
    const pairs = TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.map((to) => [from, to] as const),
    );

    it.each(pairs)('%s -> %s', (from, to) => {
      const allowed = EDGES.some(([f, t]) => f === from && t === to);
      expect(isAllowedTransition(from, to)).toBe(allowed);
      const verdict = evaluateTransition(
        facts({ status: from, currentSummary: 'done' }),
        to,
        'a summary',
      );
      if (allowed) expect(verdict.ok).toBe(true);
      else expect(verdict).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
    });

    it('covers every status and exactly the documented edges', () => {
      expect(TICKET_STATUSES).toHaveLength(5);
      expect(Object.values(ALLOWED_TRANSITIONS).flat()).toHaveLength(EDGES.length);
    });

    it('never allows skipping a step or staying put', () => {
      expect(isAllowedTransition('OPEN', 'IN_PROGRESS')).toBe(false);
      expect(isAllowedTransition('OPEN', 'RESOLVED')).toBe(false);
      expect(isAllowedTransition('TRIAGED', 'CLOSED')).toBe(false);
      expect(isAllowedTransition('OPEN', 'OPEN')).toBe(false);
      expect(isAllowedTransition('CLOSED', 'RESOLVED')).toBe(false);
    });
  });

  describe('prerequisites for TRIAGED and IN_PROGRESS', () => {
    it('accepts a fully routed ticket', () => {
      expect(evaluateTransition(facts({}), 'TRIAGED')).toEqual({ ok: true, summary: null });
      expect(evaluateTransition(facts({ status: 'TRIAGED' }), 'IN_PROGRESS').ok).toBe(true);
    });

    it.each([
      ['no category', { categoryId: null }, ['CATEGORY']],
      ['priority UNSET', { priority: 'UNSET' as const }, ['PRIORITY']],
      ['no team', { teamId: null }, ['TEAM']],
      ['inactive team', { teamActive: false }, ['ACTIVE_TEAM']],
      ['ineligible assignee', { assigneeId: 'x', assigneeEligible: false }, ['ASSIGNEE']],
      [
        'everything missing',
        { categoryId: null, priority: 'UNSET' as const, teamId: null },
        ['CATEGORY', 'PRIORITY', 'TEAM'],
      ],
    ])('rejects %s and names what is missing', (_n, over, missing) => {
      for (const [status, to] of [
        ['OPEN', 'TRIAGED'],
        ['TRIAGED', 'IN_PROGRESS'],
      ] as const) {
        expect(evaluateTransition(facts({ ...over, status }), to)).toEqual({
          ok: false,
          reason: 'PREREQUISITE_FAILED',
          missing,
        });
      }
    });

    it('accepts an eligible assignee and no assignee at all', () => {
      expect(missingPrerequisites(facts({ assigneeId: 'x', assigneeEligible: true }))).toEqual([]);
      expect(missingPrerequisites(facts({ assigneeId: null }))).toEqual([]);
    });

    it('does not require routing to resolve, close or reopen', () => {
      const bare = { categoryId: null, priority: 'UNSET' as const, teamId: null };
      expect(
        evaluateTransition(facts({ ...bare, status: 'IN_PROGRESS' }), 'RESOLVED', 's').ok,
      ).toBe(true);
      expect(evaluateTransition(facts({ ...bare, status: 'CLOSED' }), 'OPEN').ok).toBe(true);
    });
  });

  describe('resolution summary', () => {
    const inProgress = facts({ status: 'IN_PROGRESS' });
    const resolved = facts({ status: 'RESOLVED', currentSummary: 'Fixed it' });

    it('requires a nonblank summary to resolve and returns it trimmed', () => {
      for (const blank of [undefined, null, '', '   ', '\n\t']) {
        expect(evaluateTransition(inProgress, 'RESOLVED', blank)).toEqual({
          ok: false,
          reason: 'SUMMARY_REQUIRED',
        });
      }
      expect(evaluateTransition(inProgress, 'RESOLVED', '  Reinstalled  ')).toEqual({
        ok: true,
        summary: 'Reinstalled',
      });
    });

    it('keeps the existing summary on close, or takes a new nonblank one', () => {
      expect(evaluateTransition(resolved, 'CLOSED')).toEqual({ ok: true, summary: 'Fixed it' });
      expect(evaluateTransition(resolved, 'CLOSED', '   ')).toEqual({
        ok: true,
        summary: 'Fixed it',
      });
      expect(evaluateTransition(resolved, 'CLOSED', 'Confirmed')).toEqual({
        ok: true,
        summary: 'Confirmed',
      });
    });

    it('refuses to close a ticket that has no summary at all', () => {
      expect(
        evaluateTransition(facts({ status: 'RESOLVED', currentSummary: '  ' }), 'CLOSED'),
      ).toEqual({ ok: false, reason: 'SUMMARY_REQUIRED' });
    });

    it('reopening needs no summary and ignores one', () => {
      expect(evaluateTransition(resolved, 'OPEN', 'ignored')).toEqual({ ok: true, summary: null });
    });
  });
});
