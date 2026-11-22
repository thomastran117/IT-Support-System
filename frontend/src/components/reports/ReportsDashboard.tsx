'use client';

import type { ReportSummaryDto } from '@smartdesk/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ErrorState, LoadingState, Notice } from '@/components/ui';
import { useAuth } from '@/lib/auth/AuthProvider';
import { reportsApi } from '@/lib/reports/api';
import { defaultRange, isDay, rangeProblem, toWindow, type DayRange } from '@/lib/reports/range';
import { inputClass, primaryButton } from '../tickets/ui';
import { BarList, DataTable, Definitions, Kpi, pct } from './parts';

const STORAGE_KEY = 'smartdesk.reports.range';

function remembered(): DayRange | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as DayRange | null;
    return parsed && isDay(parsed.from) && isDay(parsed.to) ? parsed : null;
  } catch {
    return null;
  }
}

/** Administrator report. The applied range lives in the URL and is remembered for the session. */
export function ReportsDashboard() {
  const { api } = useAuth();
  const reports = useMemo(() => reportsApi(api), [api]);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const urlFrom = params.get('from');
  const urlTo = params.get('to');
  const hasUrl = isDay(urlFrom) && isDay(urlTo);
  // Without a URL range, fall back to the last one used this session, then the default.
  const [fallback] = useState<DayRange>(() => remembered() ?? defaultRange());
  const from = hasUrl ? urlFrom : fallback.from;
  const to = hasUrl ? urlTo : fallback.to;

  const [draft, setDraft] = useState<DayRange>({ from, to });
  const [data, setData] = useState<ReportSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);
  const problem = rangeProblem(draft);
  const appliedProblem = rangeProblem({ from, to });

  useEffect(() => {
    if (!hasUrl) router.replace(`${pathname}?from=${from}&to=${to}`);
  }, [hasUrl, router, pathname, from, to]);

  useEffect(() => {
    setDraft({ from, to });
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ from, to }));
    } catch {
      /* remembering the range is a convenience only */
    }
  }, [from, to]);

  useEffect(() => {
    if (appliedProblem) return;
    const request = ++latest.current;
    const { start, end } = toWindow({ from, to });
    setData(null);
    setError(null);
    reports.summary(start, end).then(
      (summary) => {
        if (request === latest.current) setData(summary);
      },
      () => {
        if (request === latest.current) setError('Unable to load the report. Please try again.');
      },
    );
  }, [reports, from, to, appliedProblem, reloads]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    router.push(`${pathname}?from=${draft.from}&to=${draft.to}`);
  };

  return (
    <div className="mt-6 space-y-6">
      <form onSubmit={apply} className="app-card flex flex-wrap items-end gap-4 p-4" noValidate>
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

      {appliedProblem ? (
        <Notice tone="warning" role="alert">
          {appliedProblem}
        </Notice>
      ) : error ? (
        <ErrorState
          message={error}
          action={
            <button
              type="button"
              className={primaryButton}
              onClick={() => setReloads((n) => n + 1)}
            >
              Try again
            </button>
          }
        />
      ) : !data ? (
        <LoadingState label="Loading report…" />
      ) : (
        <Report data={data} />
      )}
    </div>
  );
}

function Report({ data }: { data: ReportSummaryDto }) {
  const empty = data.submitted === 0 && data.resolution.resolvedTickets === 0;
  const minutes = (v: number | null) => (v === null ? null : `${v} min`);
  const hours = (v: number | null) => (v === null ? null : `${v} h`);
  const days = data.dailyIntake.length;
  return (
    <>
      <p className="text-sm text-slate-600" data-testid="report-window">
        {data.window.start.slice(0, 10)} to {data.window.end.slice(0, 10)} (end exclusive), {days}{' '}
        UTC {days === 1 ? 'day' : 'days'}. Averages are N/A when there is nothing to average.
      </p>
      {empty && (
        <Notice tone="info" title="No tickets in this period" role="status">
          Nothing was submitted or resolved between these dates. Try a wider range.
        </Notice>
      )}

      <section aria-labelledby="kpi-heading">
        <h2 id="kpi-heading" className="sr-only">
          Key figures
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Kpi
            id="submitted"
            label="Tickets submitted"
            value={String(data.submitted)}
            note="Created in the period"
          />
          <Kpi
            id="routed"
            label="Tickets routed"
            value={`${data.routing.routed} of ${data.submitted}`}
            note="Of those submitted, assigned to a team"
          />
          <Kpi
            id="resolved"
            label="Tickets resolved"
            value={String(data.resolution.resolvedTickets)}
            note="Currently resolved or closed, resolved in the period"
          />
          <Kpi
            id="avg-routing"
            label="Mean time to first routing"
            value={minutes(data.routing.avgMinutes)}
            note={`Over ${data.routing.routed} routed`}
          />
          <Kpi
            id="avg-response"
            label="Mean time to first public response"
            value={minutes(data.firstResponse.avgMinutes)}
            note={`Over ${data.firstResponse.responded} of ${data.submitted} answered`}
          />
          <Kpi
            id="avg-resolution"
            label="Mean time to resolution"
            value={hours(data.resolution.avgHours)}
            note={`Over ${data.resolution.resolvedTickets} resolved`}
          />
          <Kpi
            id="ai-accuracy"
            label="AI category accuracy"
            value={pct(data.aiAccuracy.accuracyPct)}
            note={`${data.aiAccuracy.correct} correct of ${data.aiAccuracy.labelledTickets} independently labelled (${data.aiAccuracy.withRecommendation} with a recommendation)`}
          />
          <Kpi
            id="ai-acceptance"
            label="AI recommendation acceptance"
            value={pct(data.aiAcceptance.acceptancePct)}
            note={`${data.aiAcceptance.accepted} accepted of ${data.aiAcceptance.reviewed} reviewed`}
          />
        </dl>
      </section>

      <section aria-labelledby="cat-heading" className="app-card space-y-4 p-5">
        <h2 id="cat-heading" className="text-lg font-semibold">
          Tickets by category
        </h2>
        {data.categories.length === 0 ? (
          <p className="text-sm text-slate-600">No tickets in this period.</p>
        ) : (
          <>
            <BarList
              items={data.categories.map((c) => ({ label: c.category, value: c.ticketCount }))}
            />
            <DataTable
              caption="Tickets by category"
              head={['Category', 'Tickets']}
              rows={data.categories.map((c) => [c.category, String(c.ticketCount)])}
            />
          </>
        )}
      </section>

      <section aria-labelledby="daily-heading" className="app-card space-y-4 p-5">
        <h2 id="daily-heading" className="text-lg font-semibold">
          Daily ticket intake
        </h2>
        <BarList
          vertical
          items={data.dailyIntake.map((d) => ({ label: d.date, value: d.submittedTickets }))}
        />
        <details>
          <summary className="cursor-pointer text-sm font-medium text-blue-700">
            Show the daily figures as a table
          </summary>
          <div className="mt-3">
            <DataTable
              caption="Daily ticket intake"
              head={['Date (UTC)', 'Submitted']}
              rows={data.dailyIntake.map((d) => [d.date, String(d.submittedTickets)])}
            />
          </div>
        </details>
      </section>
      <Definitions />
    </>
  );
}
