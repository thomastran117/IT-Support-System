'use client';

import type {
  AiEvaluationReportDto,
  CategoryRefDto,
  ClassificationLabelDto,
} from '@smartdesk/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ErrorState, LoadingState, Notice } from '@/components/ui';
import { useAuth } from '@/lib/auth/AuthProvider';
import { reportsApi } from '@/lib/reports/api';
import { toWindow } from '@/lib/reports/range';
import { useReportRange } from '@/lib/reports/useReportRange';
import { formatDateTime } from '@/lib/tickets/format';
import { inputClass, primaryButton } from '../tickets/ui';
import { DataTable, Kpi, pct } from './parts';
import { RangeForm } from './RangeForm';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Independent AI accuracy: the measured report plus label management for administrators. */
export function AiEvaluation() {
  const { api } = useAuth();
  const reports = useMemo(() => reportsApi(api), [api]);
  const { from, to, draft, setDraft, problem, appliedProblem, apply } = useReportRange();

  const [data, setData] = useState<AiEvaluationReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (appliedProblem) return;
    const request = ++latest.current;
    const { start, end } = toWindow({ from, to });
    setData(null);
    setError(null);
    reports.aiEvaluation(start, end).then(
      (report) => {
        if (request === latest.current) setData(report);
      },
      () => {
        if (request === latest.current)
          setError('Unable to load the evaluation. Please try again.');
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
        <LoadingState label="Loading evaluation…" />
      ) : (
        <Evaluation data={data} />
      )}
      <Labels onChanged={() => setReloads((n) => n + 1)} />
    </div>
  );
}

function Evaluation({ data }: { data: AiEvaluationReportDto }) {
  const o = data.overall;
  return (
    <>
      {o.labelledTickets === 0 && (
        <Notice tone="info" title="No independently labelled tickets in this period" role="status">
          Accuracy cannot be computed without labels, so it is shown as N/A. Add labels below.
        </Notice>
      )}
      <section aria-labelledby="eval-heading">
        <h2 id="eval-heading" className="sr-only">
          Accuracy and acceptance
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Kpi
            id="eval-accuracy"
            label="Category accuracy"
            value={pct(o.accuracyPct)}
            note={`${o.correct} correct of ${o.labelledTickets} labelled tickets. ${o.withRecommendation} had a valid recommendation; ${o.withoutRecommendation} had none and count as not correct.`}
          />
          <Kpi
            id="eval-acceptance"
            label="Recommendation acceptance"
            value={pct(data.acceptance.acceptancePct)}
            note={`${data.acceptance.accepted} accepted of ${data.acceptance.reviewed} reviewed in the period. A different measure from accuracy.`}
          />
        </dl>
      </section>

      <section aria-labelledby="model-heading" className="app-card space-y-3 p-5">
        <h2 id="model-heading" className="text-lg font-semibold">
          By model version
        </h2>
        {data.byModel.length === 0 ? (
          <p className="text-sm text-muted">No recommendations in this period.</p>
        ) : (
          <DataTable
            caption="Accuracy and acceptance by model version"
            head={[
              'Model version',
              'Labelled',
              'Correct',
              'Accuracy',
              'Reviewed',
              'Accepted',
              'Acceptance',
            ]}
            rows={data.byModel.map((m) => [
              m.modelVersion,
              String(m.labelledTickets),
              String(m.correct),
              pct(m.accuracyPct) ?? 'N/A',
              String(m.reviewed),
              String(m.accepted),
              pct(m.acceptancePct) ?? 'N/A',
            ])}
          />
        )}
        <p className="text-xs text-muted">
          A labelled ticket is attributed to the model that produced its first valid recommendation.
          Tickets with no valid recommendation have no model and appear only in the overall figure.
        </p>
      </section>

      <section aria-labelledby="confusion-heading" className="app-card space-y-3 p-5">
        <h2 id="confusion-heading" className="text-lg font-semibold">
          Reference versus predicted category
        </h2>
        {data.confusion.length === 0 ? (
          <p className="text-sm text-muted">No labelled tickets in this period.</p>
        ) : (
          <DataTable
            caption="Reference versus predicted category"
            head={['Reference (independent label)', 'First valid prediction', 'Tickets']}
            rows={data.confusion.map((c) => [
              c.referenceCategory,
              c.predictedCategory ?? 'No valid recommendation',
              String(c.ticketCount),
            ])}
          />
        )}
      </section>

      <p className="text-xs text-muted">
        The 90% category-accuracy target is unverified: it is only met if this measured figure, on a
        representative independently labelled set, reaches it. Small or hand-picked label sets prove
        little; the denominators above show how much evidence there is.
      </p>
    </>
  );
}

function Labels({ onChanged }: { onChanged: () => void }) {
  const { api } = useAuth();
  const reports = useMemo(() => reportsApi(api), [api]);
  const [labels, setLabels] = useState<ClassificationLabelDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<CategoryRefDto[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [ticketId, setTicketId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      reports.labels().then(
        (page) => {
          setLabels(page.items);
          setTotal(page.total);
          setLoadError(false);
        },
        () => setLoadError(true),
      ),
    [reports],
  );

  useEffect(() => {
    void load();
    reports.categories().then(setCategories, () => undefined);
  }, [reports, load]);

  const idProblem =
    ticketId && !UUID.test(ticketId.trim()) ? 'Enter the ticket ID (a UUID).' : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (idProblem || !ticketId.trim() || !categoryId) return;
    setBusy(true);
    setMessage(null);
    try {
      await reports.saveLabel(ticketId.trim(), categoryId);
      setMessage({ tone: 'success', text: 'Label saved.' });
      setTicketId('');
      await load();
      onChanged();
    } catch (err) {
      const text =
        err instanceof Error && err.message ? err.message : 'The label could not be saved.';
      setMessage({ tone: 'danger', text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="labels-heading" className="app-card space-y-4 p-5">
      <h2 id="labels-heading" className="text-lg font-semibold">
        Independent labels
      </h2>
      <p className="text-sm text-muted">
        A label is the correct category as judged by you, independent of what the AI proposed. It is
        recorded against your account. Saving again for the same ticket replaces the label.
      </p>
      <form onSubmit={save} className="flex flex-wrap items-end gap-4" noValidate>
        <div className="min-w-64 flex-1">
          <label
            htmlFor="label-ticket"
            className="mb-1 block text-sm font-medium text-muted-strong"
          >
            Ticket ID
          </label>
          <input
            id="label-ticket"
            className={inputClass}
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            aria-invalid={idProblem ? true : undefined}
            aria-describedby={idProblem ? 'label-ticket-problem' : undefined}
            autoComplete="off"
          />
          {idProblem && (
            <p id="label-ticket-problem" className="mt-1 text-sm text-danger">
              {idProblem}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="label-category"
            className="mb-1 block text-sm font-medium text-muted-strong"
          >
            Reference category
          </label>
          <select
            id="label-category"
            className={inputClass}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className={primaryButton}
          disabled={busy || Boolean(idProblem) || !ticketId.trim() || !categoryId}
        >
          Save label
        </button>
      </form>
      {message && (
        <Notice tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>
          {message.text}
        </Notice>
      )}
      {loadError ? (
        <p role="alert" className="text-sm text-danger">
          Unable to load the labels.
        </p>
      ) : labels === null ? (
        <p role="status" className="text-sm text-muted">
          Loading labels…
        </p>
      ) : labels.length === 0 ? (
        <p className="text-sm text-muted">No labels yet.</p>
      ) : (
        <>
          <p className="text-sm text-muted">
            {total} labelled {total === 1 ? 'ticket' : 'tickets'}
            {total > labels.length ? `, newest ${labels.length} shown` : ''}.
          </p>
          <DataTable
            caption="Independent labels"
            head={['Ticket ID', 'Reference category', 'Labelled by', 'When']}
            rows={labels.map((l) => [
              l.ticketId,
              l.referenceCategory.name,
              l.labelledBy.displayName,
              formatDateTime(l.labelledAt),
            ])}
          />
        </>
      )}
    </section>
  );
}
