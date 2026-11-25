import { TICKET_EVENT_TYPES } from '@smartdesk/contracts';
import { describe, expect, it } from 'vitest';
import { notificationTypeFor } from '../../../src/domain/notifications.js';

/** SD-053: which committed ticket events may reach the requester's inbox (SD-040 policy). */
describe('notificationTypeFor', () => {
  it('maps only requester-visible events to a notification type', () => {
    const expected: Record<string, string | null> = {
      TEAM_ASSIGNED: 'TICKET_ASSIGNED',
      TEAM_REASSIGNED: 'TICKET_ASSIGNED',
      STATUS_CHANGED: 'TICKET_STATUS_CHANGED',
      RESOLVED: 'TICKET_RESOLVED',
      REOPENED: 'TICKET_REOPENED',
    };
    for (const type of TICKET_EVENT_TYPES) {
      if (type === 'COMMENT_ADDED') continue;
      expect(notificationTypeFor(type, {}), type).toBe(expected[type] ?? null);
    }
  });

  it('notifies a comment only when it is explicitly public', () => {
    expect(notificationTypeFor('COMMENT_ADDED', { isInternal: false })).toBe('TECHNICIAN_REPLY');
    for (const details of [{ isInternal: true }, {}, { isInternal: 'false' }, { isInternal: 0 }]) {
      expect(notificationTypeFor('COMMENT_ADDED', details), JSON.stringify(details)).toBeNull();
    }
  });
});
