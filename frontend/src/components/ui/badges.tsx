import type { TicketPriority, TicketStatus } from '@smartdesk/contracts';
import type { ReactNode } from 'react';
import { PRIORITY_LABEL, STATUS_LABEL } from '@/lib/tickets/format';
import { cx } from './cx';

export type BadgeTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'muted';

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-line bg-panel-hover text-muted-strong',
  info: 'border-accent-line bg-accent-soft text-accent',
  warning: 'border-warning-line bg-warning-soft text-warning',
  success: 'border-success-line bg-success-soft text-success',
  danger: 'border-danger-line bg-danger-soft text-danger',
  muted: 'border-line-strong bg-panel-hover text-ink',
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
        dashed ? 'border-dashed border-line-strong bg-panel text-muted' : TONE[tone],
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
