'use client';

import { forwardRef } from 'react';

export const inputClass = 'app-field';
export const primaryButton = 'app-button-primary';
export const secondaryButton = 'app-button-secondary';

/** Kept for existing imports; the badge itself lives in the shared UI kit. */
export { StatusBadge } from '@/components/ui';

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
        className="rounded-xl border border-danger-line bg-danger-soft p-4 text-danger"
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
    <p id={id} className={`mt-1.5 text-sm ${over ? 'font-medium text-danger' : 'text-muted'}`}>
      {length.toLocaleString('en')} of {max.toLocaleString('en')} characters
      {over ? ' (too long)' : ''}
    </p>
  );
}
