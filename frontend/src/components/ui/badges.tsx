import type { TicketPriority, TicketStatus } from '@smartdesk/contracts';
import type { ReactNode } from 'react';
import { PRIORITY_LABEL, STATUS_LABEL } from '@/lib/tickets/format';
import { cx } from './cx';

export type BadgeTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'muted';

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-slate-200 bg-slate-100 text-slate-700',
  info: 'border-blue-200 bg-blue-50 text-blue-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  danger: 'border-rose-200 bg-rose-50 text-rose-800',
  muted: 'border-slate-300 bg-slate-200 text-slate-800',
};

const STATUS_TONE: Record<TicketStatus, BadgeTone> = {
  OPEN: 'neutral',
  TRIAGED: 'info',
  IN_PROGRESS: 'warning',
  RESOLVED: 'success',
  CLOSED: 'muted',
};

const PRIORITY_TONE: Record<TicketPriority, BadgeTone> = {
  CRITICAL: 'danger',
  HIGH: 'warning',
  MEDIUM: 'info',
  LOW: 'neutral',
  UNSET: 'neutral',
};

/**
 * Pill used for every status and priority. Its content is always text; colour only reinforces it.
 * The `app-badge` class keeps a visible border in forced-colors (high contrast) mode.
 */
export function Badge({
  tone = 'neutral',
  dashed = false,
  children,
}: {
  tone?: BadgeTone;
  dashed?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'app-badge inline-flex min-h-6 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        dashed ? 'border-dashed border-slate-300 bg-white text-slate-600' : TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <Badge tone={PRIORITY_TONE[priority]} dashed={priority === 'UNSET'}>
      {PRIORITY_LABEL[priority]}
    </Badge>
  );
}
