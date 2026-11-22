import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, type LucideIcon } from 'lucide-react';

import { cx } from './cx';

export { cx };
export * from './badges';
export * from './Button';
export * from './Dialog';
export * from './Toast';

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 font-semibold tracking-tight">
      <span
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-[0.65rem] bg-blue-600 text-sm font-extrabold text-white shadow-lg shadow-blue-950/20"
      >
        SD
      </span>
      {!compact && <span className="text-lg">SmartDesk</span>}
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
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-xs font-bold tracking-[0.12em] text-blue-700 uppercase">
            {eyebrow}
          </p>
        )}
        <h1
          id="page-title"
          className="text-2xl font-bold tracking-[-0.025em] text-slate-950 sm:text-3xl"
        >
          {title}
        </h1>
        {description && <p className="mt-2 max-w-2xl text-slate-600">{description}</p>}
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
    info: 'border-blue-200 bg-blue-50 text-blue-950',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-950',
    warning: 'border-amber-200 bg-amber-50 text-amber-950',
    danger: 'border-rose-200 bg-rose-50 text-rose-950',
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
      <span className="mx-auto grid size-12 place-items-center rounded-xl bg-slate-100 text-slate-500">
        <Icon aria-hidden="true" size={22} />
      </span>
      <p className="mt-4 font-semibold text-slate-900">{title}</p>
      {description && (
        <div className="mx-auto mt-2 max-w-md text-sm text-slate-600">{description}</div>
      )}
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
    <div role="alert" className="app-card border-rose-200 p-6 text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-xl bg-rose-50 text-rose-700">
        <AlertTriangle aria-hidden="true" size={21} />
      </span>
      <p className="mt-3 font-medium text-rose-950">{message}</p>
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
      className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-100 text-xs font-bold text-blue-800"
    >
      {initials}
    </span>
  );
}
