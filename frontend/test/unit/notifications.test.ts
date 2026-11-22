import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/lib/auth/client';
import { notificationsApi } from '../../src/lib/notifications/api';
import {
  badgeText,
  bellLabel,
  formatRelative,
  notificationHref,
} from '../../src/lib/notifications/format';

const fakeApi = () => {
  const request = vi.fn(async () => ({}));
  return { api: { request } as unknown as ApiClient, request };
};

describe('notificationsApi', () => {
  it('lists with only the query it was given', async () => {
    const { api, request } = fakeApi();
    await notificationsApi(api).list();
    await notificationsApi(api).list({ unreadOnly: true, limit: 10, offset: 20 });
    expect(request.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      '/api/notifications',
      '/api/notifications?unreadOnly=true&limit=10&offset=20',
    ]);
  });

  it('marks one read with PATCH and everything read with POST', async () => {
    const { api, request } = fakeApi();
    await notificationsApi(api).markRead('a/b');
    await notificationsApi(api).markAllRead();
    expect(request.mock.calls).toEqual([
      ['/api/notifications/a%2Fb/read', { method: 'PATCH' }],
      ['/api/notifications/read-all', { method: 'POST' }],
    ]);
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-03-10T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;

  it('uses plain relative wording up to a week', () => {
    expect(formatRelative(ago(5_000), now)).toBe('Just now');
    expect(formatRelative(ago(MIN), now)).toBe('1 minute ago');
    expect(formatRelative(ago(45 * MIN), now)).toBe('45 minutes ago');
    expect(formatRelative(ago(60 * MIN), now)).toBe('1 hour ago');
    expect(formatRelative(ago(5 * 60 * MIN), now)).toBe('5 hours ago');
    expect(formatRelative(ago(2 * 24 * 60 * MIN), now)).toBe('2 days ago');
  });

  it('falls back to the absolute formatter after a week, and survives bad input', () => {
    expect(formatRelative(ago(8 * 24 * 60 * MIN), now, () => 'absolute')).toBe('absolute');
    expect(formatRelative('not a date', now)).toBe('');
    // A timestamp slightly in the future (clock skew) is not shown as negative.
    expect(formatRelative(new Date(now + 5_000).toISOString(), now)).toBe('Just now');
  });
});

describe('bell helpers', () => {
  it('puts the unread total in the accessible name', () => {
    expect(bellLabel(0)).toBe('Notifications');
    expect(bellLabel(3)).toBe('Notifications, 3 unread');
  });

  it('caps the badge', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });

  it('links to the employee ticket route', () => {
    expect(notificationHref('abc-123')).toBe('/employee/tickets/abc-123');
  });
});
