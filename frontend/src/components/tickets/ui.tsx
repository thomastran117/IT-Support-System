'use client';

import type { TicketStatus } from '@smartdesk/contracts';
import { forwardRef } from 'react';
import { STATUS_LABEL } from '@/lib/tickets/format';

export const inputClass = 'app-field';
export const primaryButton = 'app-button-primary';
export const secondaryButton = 'app-button-secondary';

const BADGE: Record<TicketStatus, string> = {
  OPEN: 'border-slate-200 bg-slate-100 text-slate-700',
  TRIAGED: 'border-blue-200 bg-blue-50 text-blue-800',
  IN_PROGRESS: 'border-amber-200 bg-amber-50 text-amber-800',
  RESOLVED: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  CLOSED: 'border-slate-300 bg-slate-200 text-slate-800',
};

/** The status is always spelled out; colour only reinforces it. */
export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${BADGE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export interface SummaryItem {
  field: string;
  message: string;
}

/**
 * Error summary for forms: moves focus here after a failed submit so keyboard and screen-reader
 * users learn what is wrong, and each message links to its field.
 */
export const ErrorSummary = forwardRef<HTMLDivElement, { items: SummaryItem[] }>(
  function ErrorSummary({ items }, ref) {
    if (items.length === 0) return null;
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role="alert"
        aria-labelledby="error-summary-title"
        className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-950"
      >
        <h2 id="error-summary-title" className="font-semibold">
          There is a problem
        </h2>
        <ul className="mt-2 list-disc pl-5">
          {items.map((item) => (
            <li key={item.field}>
              <a
                href={`#${item.field}`}
                className="underline"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(item.field)?.focus();
                }}
              >
                {item.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  },
);

export function Counter({ id, length, max }: { id: string; length: number; max: number }) {
  const over = length > max;
  return (
    <p
      id={id}
      className={`mt-1.5 text-sm ${over ? 'font-medium text-rose-700' : 'text-slate-500'}`}
    >
      {length.toLocaleString('en')} of {max.toLocaleString('en')} characters
      {over ? ' (too long)' : ''}
    </p>
  );
}
