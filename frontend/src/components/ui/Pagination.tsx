import { buttonClass } from './Button';

/** Previous/Next for an offset-paged list, with a polite "Showing a–b of n" status. */
export function Pagination({
  offset,
  limit,
  count,
  total,
  nextOffset,
  busy = false,
  onChange,
}: {
  offset: number;
  limit: number;
  /** Number of items on the current page. */
  count: number;
  total: number;
  nextOffset: number | null;
  busy?: boolean;
  onChange: (offset: number) => void;
}) {
  const first = count > 0 ? offset + 1 : 0;
  const last = offset + count;
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={buttonClass('secondary')}
        disabled={busy || offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        Previous
      </button>
      <button
        type="button"
        className={buttonClass('secondary')}
        disabled={busy || nextOffset === null}
        onClick={() => nextOffset !== null && onChange(nextOffset)}
      >
        Next
      </button>
      <p role="status" className="ml-auto text-sm text-muted">
        Showing {first}–{last} of {total}
      </p>
    </nav>
  );
}
