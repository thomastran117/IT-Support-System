import { cx } from '@/components/ui';

export const pct = (v: number | null) => (v === null ? null : `${v}%`);

/** A figure card. A null value is shown as N/A, never as 0. */
export function Kpi({
  id,
  label,
  value,
  note,
}: {
  id: string;
  label: string;
  value: string | null;
  note: string;
}) {
  return (
    <div className="app-card p-4" data-testid={`kpi-${id}`}>
      <dt className="text-sm font-medium text-slate-600">{label}</dt>
      <dd className="mt-1">
        <span
          className={cx(
            'text-2xl font-bold tracking-tight',
            value === null ? 'text-slate-500' : 'text-slate-950',
          )}
        >
          {value ?? 'N/A'}
        </span>
        <span className="mt-1 block text-xs text-slate-600">{note}</span>
      </dd>
    </div>
  );
}

interface Bar {
  label: string;
  value: number;
}

/** Simple bars. Decorative: the same figures are always available in a table. */
export function BarList({ items, vertical = false }: { items: Bar[]; vertical?: boolean }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (vertical) {
    return (
      <div aria-hidden="true" className="flex h-32 items-end gap-0.5 overflow-hidden">
        {items.map((i) => (
          <div
            key={i.label}
            title={`${i.label}: ${i.value}`}
            className="min-w-0 flex-1 rounded-t bg-blue-600"
            style={{
              height: `${(i.value / max) * 100}%`,
              minHeight: i.value ? 3 : 1,
              opacity: i.value ? 1 : 0.25,
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <ul aria-hidden="true" className="space-y-2">
      {items.map((i) => (
        <li key={i.label} className="grid grid-cols-[8rem_1fr_2rem] items-center gap-2 text-sm">
          <span className="truncate">{i.label}</span>
          <span className="h-3 rounded bg-slate-100">
            <span
              className="block h-3 rounded bg-blue-600"
              style={{ width: `${(i.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function DataTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: string[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={caption} className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-slate-600">
            {head.map((h) => (
              <th key={h} scope="col" className="py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={n} className="border-b border-slate-100">
              {r.map((c, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="py-2 pr-4 font-normal">
                    {c}
                  </th>
                ) : (
                  <td key={i} className="py-2 pr-4 tabular-nums">
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Cohort definitions, so a figure is never read without its denominator. */
export function Definitions() {
  return (
    <p className="text-xs text-slate-600">
      Routing and first response cover tickets created in the period. Resolution covers tickets
      resolved in it. AI accuracy covers independently labelled tickets and counts a missing
      recommendation as not correct; acceptance is measured separately. The 90% accuracy target is
      not claimed here until it has been measured on a real data set.
    </p>
  );
}
