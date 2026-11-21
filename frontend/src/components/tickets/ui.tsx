'use client';

import type { TicketStatus } from '@smartdesk/contracts';
import { forwardRef } from 'react';
import { STATUS_LABEL } from '@/lib/tickets/format';

export const inputClass = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 text-base';
export const primaryButton =
  'rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60';
export const secondaryButton =
  'rounded border border-slate-300 bg-white px-3 py-2 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50';

const BADGE: Record<TicketStatus, string> = {
  OPEN: 'border-slate-400 bg-slate-100 text-slate-800',
  TRIAGED: 'border-sky-400 bg-sky-50 text-sky-900',
  IN_PROGRESS: 'border-amber-400 bg-amber-50 text-amber-900',
  RESOLVED: 'border-emerald-500 bg-emerald-50 text-emerald-900',
  CLOSED: 'border-slate-500 bg-slate-200 text-slate-800',
};

/** The status is always spelled out; colour only reinforces it. */
export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${BADGE[status]}`}
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
        className="rounded border border-red-300 bg-red-50 p-4 text-red-900"
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
    <p id={id} className={`mt-1 text-sm ${over ? 'font-medium text-red-700' : 'text-slate-600'}`}>
      {length.toLocaleString('en')} of {max.toLocaleString('en')} characters
      {over ? ' (too long)' : ''}
    </p>
  );
}
