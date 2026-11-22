const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A short relative time ("Just now", "5 minutes ago", "2 days ago"). Anything older than a week
 * falls back to the caller's absolute formatter. An unparseable value yields an empty string.
 */
export function formatRelative(
  iso: string,
  now: number = Date.now(),
  absolute: (iso: string) => string = (v) => v,
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, now - then);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (diff < MINUTE) return 'Just now';
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour');
  if (diff < 7 * DAY) return plural(Math.floor(diff / DAY), 'day');
  return absolute(iso);
}

/** The accessible name of the bell: it carries the unread total for screen reader users. */
export function bellLabel(unread: number): string {
  if (unread <= 0) return 'Notifications';
  return `Notifications, ${unread} unread`;
}

/** The badge text; large totals are capped so the badge keeps its shape. */
export const badgeText = (unread: number): string => (unread > 99 ? '99+' : String(unread));

/** Where a notification leads: the requester's own ticket page. */
export const notificationHref = (ticketId: string): string =>
  `/employee/tickets/${encodeURIComponent(ticketId)}`;
