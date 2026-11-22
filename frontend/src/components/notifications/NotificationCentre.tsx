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

/** The header button with the unread badge. Several can exist (desktop and mobile layouts). */
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
          className="absolute -top-1 -right-1 grid min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-[0.68rem] leading-5 font-bold text-white ring-2 ring-white"
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
        'flex items-start gap-2 border-b border-slate-100 px-4 py-3 last:border-b-0',
        !n.read && 'bg-blue-50/60',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'mt-1.5 size-2.5 shrink-0 rounded-full',
          n.read ? 'bg-transparent' : 'bg-blue-600',
        )}
      />
      <div className="min-w-0 flex-1">
        <Link
          href={notificationHref(n.ticketId)}
          onClick={() => onOpen(n)}
          className="block min-h-11 rounded-md text-sm text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        >
          <span className={cx('block', !n.read && 'font-semibold')}>
            {n.read ? null : <span className="sr-only">Unread: </span>}
            {n.message}
          </span>
          <span className="mt-0.5 block text-xs break-words text-slate-600">
            {n.ticketTitle}
            <span className="sr-only"> (ticket {n.trackingId})</span>
          </span>
        </Link>
        <time
          dateTime={n.createdAt}
          title={formatDateTime(n.createdAt)}
          className="block text-xs text-slate-600"
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
          className="grid size-10 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <Check aria-hidden="true" size={17} />
        </button>
      )}
    </li>
  );
}

/**
 * The panel. Rendered into <body> (a portal) so the sidebar's scrolling and the header's blur
 * cannot clip or re-anchor it. Non-modal: Escape or an outside click closes it and focus returns to
 * the bell that opened it.
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
      className="fixed inset-x-3 top-[4.5rem] z-[60] flex max-h-[min(32rem,calc(100vh-6rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none sm:left-auto sm:w-[24rem] lg:inset-x-auto lg:top-4 lg:left-[16.25rem]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2">
        <h2 className="text-sm font-bold text-slate-900">Notifications</h2>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void centre.markAllRead()}
              className="min-h-10 rounded-lg px-2 text-xs font-semibold text-blue-800 hover:bg-blue-50"
            >
              Mark all as read
            </button>
          )}
          <button
            type="button"
            aria-label="Close notifications"
            onClick={() => close(true)}
            className="grid size-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {status === 'error' && (
          <div role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm">
            <p className="text-rose-950">{errorMessage}</p>
            <button
              type="button"
              onClick={() => void centre.refresh()}
              className="mt-2 min-h-10 rounded-lg border border-rose-300 bg-white px-3 text-xs font-semibold text-rose-900"
            >
              Try again
            </button>
          </div>
        )}
        {status === 'loading' && (
          <p role="status" className="px-4 py-6 text-center text-sm text-slate-600">
            Loading notifications…
          </p>
        )}
        {status !== 'loading' && items.length === 0 && status !== 'error' && (
          <p
            data-testid="notification-empty"
            className="px-4 py-8 text-center text-sm text-slate-600"
          >
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
