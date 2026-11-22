const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The date inputs are inclusive calendar days in UTC; the API window is half-open. */
export interface DayRange {
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
}

export const MAX_DAYS = 366;

export function isDay(value: string | null | undefined): value is string {
  if (!value || !DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Default: the last 30 UTC days including today. */
export function defaultRange(now = Date.now()): DayRange {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { from: toDay(today - 29 * DAY_MS), to: toDay(today) };
}

/** Why a range cannot be requested, or null when it is fine. */
export function rangeProblem({ from, to }: DayRange): string | null {
  if (!isDay(from) || !isDay(to)) return 'Enter both dates.';
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (days < 1) return 'The start date must be on or before the end date.';
  if (days > MAX_DAYS) return `Choose at most ${MAX_DAYS} days.`;
  return null;
}

/** Half-open API window `[from 00:00Z, to+1 day 00:00Z)`. */
export function toWindow({ from, to }: DayRange): { start: string; end: string } {
  return {
    start: `${from}T00:00:00.000Z`,
    end: new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString(),
  };
}
