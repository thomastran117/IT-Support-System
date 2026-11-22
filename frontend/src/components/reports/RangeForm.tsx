'use client';

import type { FormEvent } from 'react';
import type { DayRange } from '@/lib/reports/range';
import { inputClass, primaryButton } from '../tickets/ui';

/** From/to day pickers (inclusive UTC days) with an Apply button and an inline problem message. */
export function RangeForm({
  draft,
  setDraft,
  problem,
  onSubmit,
}: {
  draft: DayRange;
  setDraft: (range: DayRange) => void;
  problem: string | null;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="app-card flex flex-wrap items-end gap-4 p-4" noValidate>
      <div>
        <label htmlFor="report-from" className="mb-1 block text-sm font-medium text-slate-700">
          From (UTC)
        </label>
        <input
          id="report-from"
          type="date"
          className={inputClass}
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'range-problem' : undefined}
        />
      </div>
      <div>
        <label htmlFor="report-to" className="mb-1 block text-sm font-medium text-slate-700">
          To (UTC, inclusive)
        </label>
        <input
          id="report-to"
          type="date"
          className={inputClass}
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'range-problem' : undefined}
        />
      </div>
      <button type="submit" className={primaryButton} disabled={Boolean(problem)}>
        Apply
      </button>
      {problem && (
        <p id="range-problem" role="alert" className="basis-full text-sm text-rose-700">
          {problem}
        </p>
      )}
    </form>
  );
}
