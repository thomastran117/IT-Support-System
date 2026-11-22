'use client';

import type {
  AnalysisFailureReason,
  AnalysisStatusDto,
  CategoryRefDto,
  RecommendationDto,
  ReviewDecision,
  ReviewOverride,
  TeamRefDto,
  TicketDetailDto,
} from '@smartdesk/contracts';
import { REVIEW_NOTES_MAX } from '@smartdesk/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { PRIORITY_LABEL, formatDateTime } from '@/lib/tickets/format';
import { APPROVABLE, canRoute } from '@/lib/technician/format';
import { Counter, inputClass, primaryButton, secondaryButton } from '../tickets/ui';

const DECISION_LABEL: Record<ReviewDecision, string> = {
  ACCEPTED: 'Accepted',
  OVERRIDDEN: 'Overridden',
  REJECTED: 'Rejected',
};

export interface ReviewSubmit {
  decision: ReviewDecision;
  override?: ReviewOverride;
  notes?: string;
}

interface Props {
  ticket: TicketDetailDto;
  /** null while loading */
  recommendations: RecommendationDto[] | null;
  loadFailed: boolean;
  categories: CategoryRefDto[];
  teams: TeamRefDto[];
  busy: boolean;
  onReview: (rec: RecommendationDto, submit: ReviewSubmit) => void;
  onRetry: () => void;
  /** null while loading */
  analysis: AnalysisStatusDto | null;
  analysisFailed: boolean;
  analysisNotice: string | null;
  requesting: boolean;
  onRequestAnalysis: () => void;
  onRetryAnalysis: () => void;
}

const REASON_LABEL: Record<AnalysisFailureReason, string> = {
  provider_unavailable: 'the AI service was unavailable',
  timed_out: 'the AI service took too long',
  rate_limited: 'the AI service was busy',
  invalid_response: 'the AI service gave an unusable answer',
  ticket_unavailable: 'the ticket could not be analysed',
  worker_lost: 'the analysis was interrupted',
  ai_disabled: 'AI analysis is switched off',
  internal: 'an unexpected error occurred',
};

/**
 * The analysis job: queued, running, failed, or idle, plus the "request analysis" action and the
 * keyword-based manual cue. Everything here is advisory; it never gates the routing form.
 */
function AnalysisPanel({
  analysis,
  failed,
  notice,
  requesting,
  busy,
  hasSuggestion,
  onRequest,
  onRetryLoad,
}: {
  analysis: AnalysisStatusDto | null;
  failed: boolean;
  notice: string | null;
  requesting: boolean;
  busy: boolean;
  hasSuggestion: boolean;
  onRequest: () => void;
  onRetryLoad: () => void;
}) {
  if (failed && !analysis) {
    return (
      <div role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
        <p>The AI analysis status could not be loaded. {MANUAL_NOTE}</p>
        <button type="button" className={`${secondaryButton} mt-2`} onClick={onRetryLoad}>
          Check again
        </button>
      </div>
    );
  }
  if (!analysis) return null;

  const { state, failure, manualCue } = analysis;
  const waiting = state === 'QUEUED' || state === 'RUNNING';
  const disabledByRule = !analysis.canRetry && !waiting && analysis.enabled;

  let status: React.ReactNode = null;
  if (!analysis.enabled) {
    status = <p data-testid="analysis-state">AI analysis is switched off. {MANUAL_NOTE}</p>;
  } else if (state === 'RUNNING') {
    status = (
      <p role="status" data-testid="analysis-state">
        AI analysis is running�
      </p>
    );
  } else if (state === 'QUEUED' && failure) {
    status = (
      <p role="status" data-testid="analysis-state">
        The last attempt failed because {REASON_LABEL[failure.reason]}. It will retry
        {analysis.retryAt ? ` after ${formatDateTime(analysis.retryAt)}` : ' shortly'} (attempt{' '}
        {analysis.attempts} of {analysis.maxAttempts}). {MANUAL_NOTE}
      </p>
    );
  } else if (state === 'QUEUED') {
    status = (
      <p role="status" data-testid="analysis-state">
        AI analysis is queued� {MANUAL_NOTE}
      </p>
    );
  } else if (state === 'FAILED') {
    status = (
      <div
        role="alert"
        data-testid="analysis-state"
        className="rounded border border-amber-300 bg-amber-50 p-3"
      >
        <p className="font-medium">AI analysis failed</p>
        <p>
          {failure?.message ?? 'The analysis failed.'} Tried {analysis.attempts} time
          {analysis.attempts === 1 ? '' : 's'}. No suggestion was created. {MANUAL_NOTE}
        </p>
      </div>
    );
  }

  const label =
    state === 'FAILED' ? 'Try analysis again' : hasSuggestion ? 'Re-analyse' : 'Request analysis';

  return (
    <div className="space-y-3 text-sm" data-testid="analysis-panel">
      {manualCue.highRisk && (
        <div
          role="note"
          data-testid="manual-cue"
          className="rounded border border-red-300 bg-red-50 p-3 text-red-900"
        >
          <p className="font-medium">This ticket looks high risk. Consider handling it first.</p>
          <p>
            {manualCue.reasons.join('; ')}. This is a simple keyword check, not an AI result, and it
            changes nothing.
          </p>
        </div>
      )}
      {status}
      {analysis.enabled && !waiting && (
        <div className="space-y-1">
          <button
            type="button"
            disabled={requesting || busy || !analysis.canRetry}
            className={secondaryButton}
            onClick={onRequest}
          >
            {requesting ? 'Requesting�' : label}
          </button>
          {state !== 'FAILED' && hasSuggestion && (
            <p className="text-slate-600">
              A new analysis adds a separate suggestion. It never changes the approved routing.
            </p>
          )}
          {disabledByRule && (
            <p className="text-slate-600" data-testid="analysis-limit">
              This ticket has reached the hourly analysis limit. Try again later.
            </p>
          )}
        </div>
      )}
      {notice && (
        <p role="alert" className="font-medium text-amber-900" data-testid="analysis-notice">
          {notice}
        </p>
      )}
    </div>
  );
}

const MANUAL_NOTE = 'Manual routing is not affected.';

const staleReason = (rec: RecommendationDto): string | null => {
  const parts: string[] = [];
  if (rec.proposed.category && !rec.proposed.category.isActive) parts.push('category');
  if (rec.proposed.team && !rec.proposed.team.isActive) parts.push('team');
  return parts.length ? `The suggested ${parts.join(' and ')} is no longer active.` : null;
};

function Comparison({ rec, ticket }: { rec: RecommendationDto; ticket: TicketDetailDto }) {
  const rows: { label: string; suggested: string; approved: string }[] = [
    {
      label: 'Category',
      suggested: rec.proposed.category?.name ?? 'No suggestion',
      approved: ticket.category?.name ?? 'Not set',
    },
    {
      label: 'Priority',
      suggested: rec.proposed.priority ? PRIORITY_LABEL[rec.proposed.priority] : 'No suggestion',
      approved: PRIORITY_LABEL[ticket.priority],
    },
    {
      label: 'Team',
      suggested: rec.proposed.team?.name ?? 'No suggestion',
      approved: ticket.team?.name ?? 'Not assigned',
    },
  ];
  return (
    <table className="w-full max-w-xl text-left text-sm">
      <caption className="sr-only">AI suggestion compared with the approved values</caption>
      <thead>
        <tr>
          <th scope="col" className="p-2">
            Field
          </th>
          <th scope="col" className="p-2">
            AI suggested
          </th>
          <th scope="col" className="p-2">
            Currently approved
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-slate-200">
            <th scope="row" className="p-2 font-medium">
              {r.label}
            </th>
            <td className="p-2" data-testid={`suggested-${r.label.toLowerCase()}`}>
              {r.suggested}
            </td>
            <td className="p-2" data-testid={`approved-${r.label.toLowerCase()}`}>
              {r.approved}
              {r.suggested !== 'No suggestion' && r.suggested === r.approved && (
                <span className="ml-2 text-xs text-slate-600">(matches)</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Details({ rec }: { rec: RecommendationDto }) {
  return (
    <div className="space-y-2 text-sm">
      {rec.suggestion && (
        <p>
          <span className="font-medium">Suggested fix:</span>{' '}
          <span className="whitespace-pre-wrap">{rec.suggestion}</span>
        </p>
      )}
      {rec.articles.length > 0 && (
        <p>
          <span className="font-medium">Related articles:</span>{' '}
          {rec.articles.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ', '}
              <Link href={`/technician/knowledge/${a.id}`} className="underline">
                {a.title}
              </Link>
            </span>
          ))}
        </p>
      )}
      <p className="text-slate-600">
        {rec.modelVersion}, {formatDateTime(rec.createdAt)}
        {rec.confidence !== null &&
          `. Model-reported confidence ${Math.round(rec.confidence * 100)}% (not a probability)`}
      </p>
    </div>
  );
}

function ReviewedLine({ rec }: { rec: RecommendationDto }) {
  if (rec.review.status === 'PENDING') return null;
  return (
    <p className="text-sm" data-testid="review-outcome">
      <span className="font-medium">{DECISION_LABEL[rec.review.status]}</span>
      {rec.review.reviewer && ` by ${rec.review.reviewer.name}`}
      {rec.review.reviewedAt && ` on ${formatDateTime(rec.review.reviewedAt)}`}
      {rec.review.notes && `: ${rec.review.notes}`}
    </p>
  );
}

export function RecommendationCard({
  ticket,
  recommendations,
  loadFailed,
  categories,
  teams,
  busy,
  onReview,
  onRetry,
  analysis,
  analysisFailed,
  analysisNotice,
  requesting,
  onRequestAnalysis,
  onRetryAnalysis,
}: Props) {
  const [notes, setNotes] = useState('');
  const [overriding, setOverriding] = useState(false);
  const [override, setOverride] = useState<{
    categoryId: string;
    priority: string;
    teamId: string;
  }>({ categoryId: '', priority: '', teamId: '' });
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const manualNote = 'Manual routing never depends on AI suggestions.';

  let body;
  if (loadFailed) {
    body = (
      <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
        <p>AI suggestions could not be loaded. {manualNote}</p>
        <button type="button" className={`${secondaryButton} mt-2`} onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  } else if (recommendations === null) {
    body = (
      <p role="status" className="text-sm text-slate-600">
        Loading AI suggestions…
      </p>
    );
  } else if (recommendations.length === 0) {
    body = (
      <p className="text-sm text-slate-600" data-testid="ai-note">
        There is no AI suggestion for this ticket. {manualNote}
      </p>
    );
  } else {
    const [latest, ...earlier] = recommendations as [RecommendationDto, ...RecommendationDto[]];
    const pending = latest.review.status === 'PENDING';
    const stale = staleReason(latest);
    const routable = canRoute(ticket.status);

    const startOverride = () => {
      setOverride({
        categoryId: latest.proposed.category?.isActive ? latest.proposed.category.id : '',
        priority:
          latest.proposed.priority && latest.proposed.priority !== 'UNSET'
            ? latest.proposed.priority
            : '',
        teamId: latest.proposed.team?.isActive ? latest.proposed.team.id : '',
      });
      setOverrideError(null);
      setOverriding(true);
    };

    const submitOverride = () => {
      const values: ReviewOverride = {
        ...(override.categoryId ? { categoryId: override.categoryId } : {}),
        ...(override.priority ? { priority: override.priority as ReviewOverride['priority'] } : {}),
        ...(override.teamId ? { teamId: override.teamId } : {}),
      };
      if (Object.keys(values).length === 0) {
        setOverrideError('Choose at least one value to override.');
        return;
      }
      setOverrideError(null);
      onReview(latest, {
        decision: 'OVERRIDDEN',
        override: values,
        notes: notes.trim() || undefined,
      });
    };

    body = (
      <div className="space-y-4">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded border border-violet-400 bg-violet-50 px-2 py-0.5 font-semibold text-violet-900">
            {pending ? 'AI suggestion — requires review' : 'Latest AI suggestion — reviewed'}
          </span>
        </p>
        <Comparison rec={latest} ticket={ticket} />
        <Details rec={latest} />
        <ReviewedLine rec={latest} />

        {pending && (
          <div className="space-y-3">
            {stale && (
              <p role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
                {stale} Override the value or reject the suggestion.
              </p>
            )}
            {!routable && (
              <p role="status" className="text-sm text-slate-600">
                This ticket is {ticket.status === 'CLOSED' ? 'closed' : 'resolved'}, so a suggestion
                cannot change its routing. You can still reject it.
              </p>
            )}
            <div>
              <label htmlFor="review-notes" className="block text-sm font-medium">
                Review notes (optional)
              </label>
              <textarea
                id="review-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className={inputClass}
              />
              <Counter
                id="review-notes-count"
                length={notes.trim().length}
                max={REVIEW_NOTES_MAX}
              />
            </div>

            {overriding && routable && (
              <fieldset className="grid gap-3 rounded border border-slate-200 p-3 sm:grid-cols-3">
                <legend className="px-1 text-sm font-medium">Your values</legend>
                <div>
                  <label htmlFor="override-category" className="block text-sm">
                    Override category
                  </label>
                  <select
                    id="override-category"
                    value={override.categoryId}
                    onChange={(e) => setOverride({ ...override, categoryId: e.target.value })}
                    className={inputClass}
                  >
                    <option value="">Keep the suggestion</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="override-priority" className="block text-sm">
                    Override priority
                  </label>
                  <select
                    id="override-priority"
                    value={override.priority}
                    onChange={(e) => setOverride({ ...override, priority: e.target.value })}
                    className={inputClass}
                  >
                    <option value="">Keep the suggestion</option>
                    {[...APPROVABLE].reverse().map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="override-team" className="block text-sm">
                    Override team
                  </label>
                  <select
                    id="override-team"
                    value={override.teamId}
                    onChange={(e) => setOverride({ ...override, teamId: e.target.value })}
                    className={inputClass}
                  >
                    <option value="">Keep the suggestion</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                {overrideError && (
                  <p role="alert" className="text-sm font-medium text-red-700 sm:col-span-3">
                    {overrideError}
                  </p>
                )}
                <div className="flex gap-3 sm:col-span-3">
                  <button
                    type="button"
                    disabled={busy}
                    className={primaryButton}
                    onClick={submitOverride}
                  >
                    Apply override
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={secondaryButton}
                    onClick={() => setOverriding(false)}
                  >
                    Cancel
                  </button>
                </div>
              </fieldset>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy || !routable || stale !== null}
                className={primaryButton}
                onClick={() =>
                  onReview(latest, { decision: 'ACCEPTED', notes: notes.trim() || undefined })
                }
              >
                Accept suggestion
              </button>
              <button
                type="button"
                disabled={busy || !routable || overriding}
                className={secondaryButton}
                onClick={startOverride}
              >
                Override…
              </button>
              <button
                type="button"
                disabled={busy}
                className={secondaryButton}
                onClick={() =>
                  onReview(latest, { decision: 'REJECTED', notes: notes.trim() || undefined })
                }
              >
                Reject suggestion
              </button>
            </div>
          </div>
        )}

        {earlier.length > 0 && (
          <details className="rounded border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Earlier suggestions ({earlier.length})
            </summary>
            <ul className="mt-3 space-y-3">
              {earlier.map((r) => (
                <li key={r.id} data-testid="earlier-suggestion" className="space-y-1 text-sm">
                  <p className="font-medium">
                    {formatDateTime(r.createdAt)}:{' '}
                    {r.review.status === 'PENDING'
                      ? 'Not reviewed'
                      : DECISION_LABEL[r.review.status]}
                  </p>
                  <p>
                    Suggested {r.proposed.category?.name ?? 'no category'},{' '}
                    {r.proposed.priority ? PRIORITY_LABEL[r.proposed.priority] : 'no priority'},{' '}
                    {r.proposed.team?.name ?? 'no team'}.
                  </p>
                  <ReviewedLine rec={r} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="ai-title"
      className="space-y-3 rounded border border-slate-200 bg-white p-4"
    >
      <h3 id="ai-title" className="text-lg font-semibold">
        AI suggestions
      </h3>
      <AnalysisPanel
        analysis={analysis}
        failed={analysisFailed}
        notice={analysisNotice}
        requesting={requesting}
        busy={busy}
        hasSuggestion={(recommendations?.length ?? 0) > 0}
        onRequest={onRequestAnalysis}
        onRetryLoad={onRetryAnalysis}
      />
      {body}
    </section>
  );
}
