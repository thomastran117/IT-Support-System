'use client';

import type { ReportSummaryDto } from '@smartdesk/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorState, LoadingState, Notice } from '@/components/ui';
import { useAuth } from '@/lib/auth/AuthProvider';
import { reportsApi } from '@/lib/reports/api';
import { toWindow } from '@/lib/reports/range';
import { useReportRange } from '@/lib/reports/useReportRange';
import { primaryButton } from '../tickets/ui';
import { BarList, DataTable, Definitions, Kpi, pct } from './parts';
import { RangeForm } from './RangeForm';

/** Administrator report. The applied range lives in the URL and is remembered for the session. */
export function ReportsDashboard() {
  const { api } = useAuth();
  const reports = useMemo(() => reportsApi(api), [api]);
  const { from, to, draft, setDraft, problem, appliedProblem, apply } = useReportRange();

  const [data, setData] = useState<ReportSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);

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

  return (
    <div className="mt-6 space-y-6">
      <RangeForm draft={draft} setDraft={setDraft} problem={problem} onSubmit={apply} />

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
