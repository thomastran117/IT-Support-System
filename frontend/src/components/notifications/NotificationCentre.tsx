'use client';

import type { NotificationDto } from '@smartdesk/contracts';
import { Bell, Check, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth/AuthProvider';
import { pollIntervalMs } from '@/lib/config';
import { badgeText, bellLabel, formatRelative, notificationHref } from '@/lib/notifications/format';
import { notificationsApi } from '@/lib/notifications/api';
import { describeError, formatDateTime } from '@/lib/tickets/format';
import { usePolling } from '@/lib/tickets/usePolling';
import { cx } from '../ui';

const PAGE = 10;

export interface NotificationCentreState {
  items: NotificationDto[];
  unreadCount: number;
  /** `loading` until the first response; afterwards `ready`, or `error` while the last call failed. */
  status: 'loading' | 'ready' | 'error';
  errorMessage: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The button that opened the panel, so focus can return to it. */
  trigger: RefObject<HTMLElement | null>;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

/**
 * One notification state per signed-in employee. The unread count is whatever the server last
 * said (never computed locally), refreshed by light polling while the tab is visible and on every
 * navigation. A failed poll keeps the last known list and count instead of blanking the badge.
 */
export function useNotificationCentre(enabled: boolean): NotificationCentreState {
  const { api } = useAuth();
  const notifications = useMemo(() => notificationsApi(api), [api]);
  const pathname = usePathname();
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const page = await notifications.list({ limit: PAGE });
      if (mine !== latest.current) return; // a newer request already answered
      setItems(page.items);
      setUnreadCount(page.unreadCount);
      setStatus('ready');
      setErrorMessage('');
    } catch (err) {
      if (mine !== latest.current) return;
      setStatus('error');
      setErrorMessage(describeError(err, 'notifications'));
    }
  }, [notifications]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh, pathname]);
  usePolling(() => void refresh(), pollIntervalMs(), enabled);
  // Opening the panel always shows fresh data, whatever the polling interval is.
  useEffect(() => {
    if (enabled && open) void refresh();
  }, [enabled, open, refresh]);

  const markRead = useCallback(
    async (id: string) => {
      try {
        const result = await notifications.markRead(id);
        setUnreadCount(result.unreadCount);
        setItems((prev) =>
          prev.map((n) =>
            n.id === id ? { ...n, read: true, readAt: n.readAt ?? new Date().toISOString() } : n,
          ),
        );
      } catch (err) {
        setErrorMessage(describeError(err, 'notification'));
        setStatus('error');
      }
      await refresh();
    },
    [notifications, refresh],
  );

  const markAllRead = useCallback(async () => {
    try {
      await notifications.markAllRead();
    } catch (err) {
      setErrorMessage(describeError(err, 'notifications'));
      setStatus('error');
      return;
    }
    await refresh();
  }, [notifications, refresh]);

  return {
    items,
    unreadCount,
    status,
    errorMessage,
    open,
    setOpen,
    trigger,
    refresh,
    markRead,
    markAllRead,
  };
}

/** The workspace header button with the unread badge. */
export function NotificationBell({
  centre,
  className,
}: {
  centre: NotificationCentreState;
  className?: string;
}) {
  const { unreadCount, open } = centre;
  return (
    <button
      type="button"
      aria-label={bellLabel(unreadCount)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="notification-panel"
      data-testid="notification-bell"
      onClick={(event) => {
        centre.trigger.current = event.currentTarget;
        centre.setOpen(!open);
      }}
      className={cx('relative grid size-10 shrink-0 place-items-center rounded-lg', className)}
    >
      <Bell aria-hidden="true" size={19} />
      {unreadCount > 0 && (
        <span
          aria-hidden="true"
          data-testid="notification-badge"
          className="absolute -top-1 -right-1 grid min-w-5 place-items-center rounded-full bg-danger-fill px-1 text-[0.68rem] leading-5 font-bold text-on-accent ring-2 ring-panel"
        >
          {badgeText(unreadCount)}
        </span>
      )}
    </button>
  );
}

function Item({
  n,
  onOpen,
  onMarkRead,
}: {
  n: NotificationDto;
  onOpen: (n: NotificationDto) => void;
  onMarkRead: (id: string) => void;
}) {
  return (
    <li
      data-testid="notification-item"
      data-unread={n.read ? 'false' : 'true'}
      className={cx(
        'flex items-start gap-2 border-b border-line px-4 py-3 last:border-b-0',
        !n.read && 'bg-accent-soft/60',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'mt-1.5 size-2.5 shrink-0 rounded-full',
          n.read ? 'bg-transparent' : 'bg-accent-fill',
        )}
      />
      <div className="min-w-0 flex-1">
        <Link
          href={notificationHref(n.ticketId)}
          onClick={() => onOpen(n)}
          className="block min-h-11 rounded-md text-sm text-ink-strong hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span className={cx('block', !n.read && 'font-semibold')}>
            {n.read ? null : <span className="sr-only">Unread: </span>}
            {n.message}
          </span>
          <span className="mt-0.5 block text-xs break-words text-muted">
            {n.ticketTitle}
            <span className="sr-only"> (ticket {n.trackingId})</span>
          </span>
        </Link>
        <time
          dateTime={n.createdAt}
          title={formatDateTime(n.createdAt)}
          className="block text-xs text-muted"
        >
          {formatRelative(n.createdAt, Date.now(), formatDateTime)}
        </time>
      </div>
      {!n.read && (
        <button
          type="button"
          onClick={() => onMarkRead(n.id)}
          aria-label={`Mark as read: ${n.message} ${n.ticketTitle}`}
          title="Mark as read"
          className="grid size-10 shrink-0 place-items-center rounded-lg text-muted hover:bg-panel-hover hover:text-ink-strong"
        >
          <Check aria-hidden="true" size={17} />
        </button>
      )}
    </li>
  );
}

/**
 * The panel lives above the workspace header. Escape returns focus to the bell.
 */
export function NotificationPanel({ centre }: { centre: NotificationCentreState }) {
  const { open, setOpen, trigger, items, status, errorMessage, unreadCount } = centre;
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      if (returnFocus) trigger.current?.focus();
    },
    [setOpen, trigger],
  );

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close, trigger]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      id="notification-panel"
      ref={panelRef}
      role="dialog"
      aria-label="Notifications"
      tabIndex={-1}
      className="fixed inset-x-3 top-[4.5rem] z-[60] flex max-h-[min(32rem,calc(100dvh-6rem))] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-lg outline-none sm:right-6 sm:left-auto sm:w-96 xl:right-8"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm font-bold text-ink-strong">Notifications</h2>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void centre.markAllRead()}
              className="min-h-10 rounded-lg px-2 text-xs font-semibold text-accent hover:bg-accent-soft"
            >
              Mark all as read
            </button>
          )}
          <button
            type="button"
            aria-label="Close notifications"
            onClick={() => close(true)}
            className="grid size-10 place-items-center rounded-lg text-muted hover:bg-panel-hover"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {status === 'error' && (
          <div
            role="alert"
            className="border-b border-danger-line bg-danger-soft px-4 py-3 text-sm"
          >
            <p className="text-danger">{errorMessage}</p>
            <button
              type="button"
              onClick={() => void centre.refresh()}
              className="mt-2 min-h-10 rounded-lg border border-danger-line bg-panel px-3 text-xs font-semibold text-danger"
            >
              Try again
            </button>
          </div>
        )}
        {status === 'loading' && (
          <p role="status" className="px-4 py-6 text-center text-sm text-muted">
            Loading notifications…
          </p>
        )}
        {status !== 'loading' && items.length === 0 && status !== 'error' && (
          <p data-testid="notification-empty" className="px-4 py-8 text-center text-sm text-muted">
            You have no notifications yet. Updates to your tickets will appear here.
          </p>
        )}
        {items.length > 0 && (
          <ul aria-label="Recent notifications">
            {items.map((n) => (
              <Item
                key={n.id}
                n={n}
                onOpen={(item) => {
                  close(false);
                  if (!item.read) void centre.markRead(item.id);
                }}
                onMarkRead={(id) => void centre.markRead(id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
