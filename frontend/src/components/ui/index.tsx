import type { ReactNode } from 'react';
import { AlertTriangle, Headphones, Inbox, type LucideIcon } from 'lucide-react';

import { cx } from './cx';

export { cx };
export * from './badges';
export * from './Button';
export * from './ConfirmDialog';
export * from './Pagination';
export * from './Dialog';
export * from './Toast';

export function BrandMark() {
  return (
    <span className="inline-flex items-center gap-2.5 font-semibold tracking-tight">
      <span
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-lg bg-accent-fill text-on-accent"
      >
        <Headphones size={20} />
      </span>
      <span className="text-lg text-ink-strong">SmartDesk</span>
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-sm font-semibold text-accent">{eyebrow}</p>}
        <h1
          id="page-title"
          className="text-3xl font-semibold leading-tight tracking-[-0.035em] break-words text-ink-strong sm:text-4xl"
        >
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
  role,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  const tones = {
    info: 'border-accent-line bg-accent-soft text-accent',
    success: 'border-success-line bg-success-soft text-success',
    warning: 'border-warning-line bg-warning-soft text-warning',
    danger: 'border-danger-line bg-danger-soft text-danger',
  };
  return (
    <div role={role} className={cx('rounded-xl border p-4', tones[tone])}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={cx('text-sm leading-6', title && 'mt-1')}>{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="app-card px-6 py-12 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-xl bg-panel-hover text-muted">
        <Icon aria-hidden="true" size={22} />
      </span>
      <p className="mt-4 font-semibold text-ink-strong">{title}</p>
      {description && <div className="mx-auto mt-2 max-w-md text-sm text-muted">{description}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="app-card space-y-4 p-5">
      <span className="sr-only">{label}</span>
      <div className="skeleton h-5 w-1/3" />
      <div className="skeleton h-12 w-full" />
      <div className="skeleton h-12 w-full" />
      <div className="skeleton h-12 w-4/5" />
    </div>
  );
}

export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div role="alert" className="app-card border-danger-line p-6 text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-xl bg-danger-soft text-danger">
        <AlertTriangle aria-hidden="true" size={21} />
      </span>
      <p className="mt-3 font-medium text-danger">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent"
    >
      {initials}
    </span>
  );
}
