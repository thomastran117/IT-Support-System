'use client';

import type {
  ApproveRoutingRequest,
  CategoryRefDto,
  TeamMemberRefDto,
  TeamRefDto,
  TicketDetailDto,
} from '@smartdesk/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { PRIORITY_LABEL, STATUS_HELP, formatDateTime } from '@/lib/tickets/format';
import { LIMITS, validateReply } from '@/lib/tickets/validation';
import { technicianApi } from '@/lib/technician/api';
import {
  APPROVABLE,
  canRoute,
  describeStaffEvent,
  describeTriageError,
  statusActions,
  transitionRequest,
  type StatusAction,
  type TriageError,
} from '@/lib/technician/format';
import { Counter, inputClass, primaryButton, secondaryButton, StatusBadge } from '../tickets/ui';
import { PriorityChip } from './PriorityChip';

interface RoutingForm {
  categoryId: string;
  priority: ApproveRoutingRequest['priority'] | '';
  teamId: string;
  assigneeId: string;
}

const formFrom = (t: TicketDetailDto): RoutingForm => ({
  categoryId: t.category?.id ?? '',
  priority: t.priority === 'UNSET' ? '' : (t.priority as RoutingForm['priority']),
  teamId: t.team?.id ?? '',
  assigneeId: t.assignee?.id ?? '',
});

export function TriageDetail() {
  const { id } = useParams<{ id: string }>();
  const { api, user } = useAuth();
  const tech = useMemo(() => technicianApi(api), [api]);

  const [ticket, setTicket] = useState<TicketDetailDto | null>(null);
  const [loadError, setLoadError] = useState<TriageError | null>(null);
  const [teams, setTeams] = useState<TeamRefDto[]>([]);
  const [categories, setCategories] = useState<CategoryRefDto[]>([]);
  const [members, setMembers] = useState<TeamMemberRefDto[]>([]);
  const [form, setForm] = useState<RoutingForm>({
    categoryId: '',
    priority: '',
    teamId: '',
    assigneeId: '',
  });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [summary, setSummary] = useState('');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState(true);
  const [noteError, setNoteError] = useState<string | null>(null);

  /** Load the ticket and reset the routing form to what the server now says. */
  const load = useCallback(async (): Promise<TriageError | null> => {
    try {
      const next = await tech.ticket(id);
      setTicket(next);
      setForm(formFrom(next));
      setLoadError(null);
      return null;
    } catch (err) {
      const problem = describeTriageError(err);
      setLoadError(problem);
      return problem;
    }
  }, [tech, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reference data for the form. The page still works read-only if these fail.
  useEffect(() => {
    let cancelled = false;
    void tech
      .allTeams()
      .then((t) => !cancelled && setTeams(t))
      .catch(() => undefined);
    void tech
      .categories()
      .then((c) => !cancelled && setCategories(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tech]);

  // Eligible assignees follow the selected team.
  useEffect(() => {
    if (!form.teamId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    void tech
      .members(form.teamId)
      .then((m) => {
        if (cancelled) return;
        setMembers(m);
        setForm((f) => (m.some((x) => x.id === f.assigneeId) ? f : { ...f, assigneeId: '' }));
      })
      .catch(() => !cancelled && setMembers([]));
    return () => {
      cancelled = true;
    };
  }, [tech, form.teamId]);

  /** Run one mutation. A version conflict reloads the ticket so the next attempt is informed. */
  async function act(work: () => Promise<unknown>, okText: string): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await work();
      const reloadProblem = await load();
      if (reloadProblem?.kind === 'gone') {
        // The change was saved, but the ticket now belongs to a team this technician is not in
        // (the access rule hides it), so there is nothing left to show.
        setTicket(null);
        setMoved(
          `${okText} The ticket now belongs to a team you are not a member of, so you can no longer open it.`,
        );
        return true;
      }
      setNotice({ tone: 'ok', text: okText });
      return true;
    } catch (err) {
      const problem = describeTriageError(err);
      if (problem.kind === 'conflict') await load();
      setNotice({ tone: 'error', text: problem.message });
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function onRoute(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ticket) return;
    if (!form.categoryId || !form.priority || !form.teamId) {
      setNotice({ tone: 'error', text: 'Choose a category, priority and team before approving.' });
      return;
    }
    const { categoryId, priority, teamId, assigneeId } = form;
    void act(
      () =>
        tech.approveRouting(id, {
          categoryId,
          priority,
          teamId,
          assigneeId: assigneeId || null,
          expectedVersion: ticket.version,
        }),
      'Routing approved.',
    );
  }

  function onStatus(action: StatusAction) {
    if (!ticket) return;
    if (action.needsSummary && !summary.trim()) {
      setSummaryError('Enter a resolution summary before resolving the ticket.');
      document.getElementById('summary')?.focus();
      return;
    }
    setSummaryError(null);
    void act(
      () => tech.transition(id, transitionRequest(action, ticket.version, summary)),
      `Ticket ${action.label.toLowerCase()} done.`,
    ).then((ok) => ok && setSummary(''));
  }

  async function onComment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problem = validateReply(note);
    setNoteError(problem);
    if (problem) {
      document.getElementById('note')?.focus();
      return;
    }
    const ok = await act(
      () => tech.comment(id, { body: note.trim(), isInternal: internal }),
      internal ? 'Internal note added.' : 'Reply sent to the requester.',
    );
    if (ok) setNote('');
  }

  if (moved && !ticket) {
    return (
      <section aria-labelledby="page-title" className="space-y-4">
        <h1 id="page-title" className="text-2xl font-semibold">
          Ticket handed over
        </h1>
        <p role="status" className="rounded border border-emerald-400 bg-emerald-50 p-4">
          {moved}
        </p>
        <Link href="/technician" className={secondaryButton}>
          Back to the dashboard
        </Link>
      </section>
    );
  }

  if (loadError && !ticket) {
    return (
      <section aria-labelledby="page-title" className="space-y-4">
        <h1 id="page-title" className="text-2xl font-semibold">
          {loadError.kind === 'gone' ? 'Ticket not found' : 'Ticket unavailable'}
        </h1>
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-4 text-red-900">
          {loadError.message}
        </p>
        <div className="flex gap-3">
          {loadError.kind !== 'gone' && (
            <button type="button" className={secondaryButton} onClick={() => void load()}>
              Try again
            </button>
          )}
          <Link href="/technician" className={secondaryButton}>
            Back to the dashboard
          </Link>
        </div>
      </section>
    );
  }

  if (!ticket) {
    return (
      <p role="status" className="text-slate-600">
        Loading ticket…
      </p>
    );
  }

  const editable = canRoute(ticket.status);
  const actions = statusActions(ticket.status);
  const needsSummary = actions.some((a) => a.needsSummary);
  const dirty =
    JSON.stringify(form) !== JSON.stringify(formFrom(ticket)) || ticket.status === 'OPEN';

  return (
    <article aria-labelledby="page-title" className="space-y-6">
      <p className="text-sm">
        <Link href="/technician" className="app-button-quiet min-h-9 px-2 py-1.5">
          Dashboard
        </Link>
      </p>

      <div aria-live="polite" role="status" className="empty:hidden">
        {notice && (
          <p
            role={notice.tone === 'error' ? 'alert' : undefined}
            data-testid="notice"
            className={`rounded border p-3 ${
              notice.tone === 'error'
                ? 'border-red-300 bg-red-50 text-red-900'
                : 'border-emerald-400 bg-emerald-50'
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      <header className="app-card space-y-3 p-5 sm:p-6">
        <h1 id="page-title" className="text-2xl font-bold tracking-[-0.025em] text-slate-950 sm:text-3xl">
          {ticket.title}
        </h1>
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={ticket.status} />
          <PriorityChip priority={ticket.priority} />
          <span>{STATUS_HELP[ticket.status]}</span>
        </p>
        <p className="text-sm text-slate-600">
          Requested by {ticket.requester.name} on {formatDateTime(ticket.createdAt)}. Tracking ID:{' '}
          <code className="break-all font-mono">{ticket.trackingId}</code>
        </p>
      </header>

      <section aria-labelledby="description-title" className="app-card space-y-3 p-5 sm:p-6">
        <h2 id="description-title" className="text-lg font-bold text-slate-950">
          Description
        </h2>
        <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-slate-700 ring-1 ring-slate-200">
          {ticket.description}
        </p>
        {ticket.resolutionSummary && (
          <div>
            <h3 className="font-medium">Resolution</h3>
            <p className="mt-2 whitespace-pre-wrap rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
              {ticket.resolutionSummary}
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="routing-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2 id="routing-title" className="text-lg font-bold text-slate-950">
          Approved routing
        </h2>
        <p className="text-sm text-slate-600">
          These are the values the ticket is actually worked under. They only change when you
          approve them here.
        </p>
        {!editable ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium">Category</dt>
              <dd>{ticket.category?.name ?? 'Not set'}</dd>
            </div>
            <div>
              <dt className="font-medium">Priority</dt>
              <dd>{PRIORITY_LABEL[ticket.priority]}</dd>
            </div>
            <div>
              <dt className="font-medium">Team</dt>
              <dd>{ticket.team?.name ?? 'Not assigned'}</dd>
            </div>
            <div>
              <dt className="font-medium">Assignee</dt>
              <dd>{ticket.assignee?.name ?? 'Unassigned'}</dd>
            </div>
          </dl>
        ) : (
          <form
            onSubmit={onRoute}
            noValidate
            className="grid gap-4 sm:grid-cols-2"
            aria-busy={busy}
          >
            <div>
              <label htmlFor="route-category" className="app-label">
                Category
              </label>
              <select
                id="route-category"
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                className={inputClass}
              >
                <option value="">Choose a category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="route-priority" className="app-label">
                Priority
              </label>
              <select
                id="route-priority"
                value={form.priority}
                onChange={(e) =>
                  setForm({ ...form, priority: e.target.value as RoutingForm['priority'] })
                }
                className={inputClass}
              >
                <option value="">Choose a priority</option>
                {[...APPROVABLE].reverse().map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="route-team" className="app-label">
                Team
              </label>
              <select
                id="route-team"
                value={form.teamId}
                onChange={(e) => setForm({ ...form, teamId: e.target.value, assigneeId: '' })}
                className={inputClass}
              >
                <option value="">Choose a team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="route-assignee" className="app-label">
                Assignee
              </label>
              <select
                id="route-assignee"
                value={form.assigneeId}
                disabled={!form.teamId}
                onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
                className={inputClass}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <button type="submit" disabled={busy || !dirty} className={primaryButton}>
                {ticket.status === 'OPEN' ? 'Approve routing' : 'Save routing'}
              </button>
            </div>
          </form>
        )}
        <p className="text-sm text-slate-600" data-testid="ai-note">
          AI suggestions will appear here once analysis is available. Manual routing never depends
          on them.
        </p>
      </section>

      <section aria-labelledby="status-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2 id="status-title" className="text-lg font-bold text-slate-950">
          Progress
        </h2>
        {actions.length === 0 ? (
          <p className="text-slate-600">
            Approve the routing above to move this ticket to triaged.
          </p>
        ) : (
          <>
            {needsSummary && (
              <div>
                <label htmlFor="summary" className="app-label">
                  Resolution summary (required to resolve)
                </label>
                <textarea
                  id="summary"
                  rows={3}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  aria-invalid={summaryError ? true : undefined}
                  aria-describedby={summaryError ? 'summary-error' : undefined}
                  className={inputClass}
                />
                {summaryError && (
                  <p
                    id="summary-error"
                    role="alert"
                    className="mt-1 text-sm font-medium text-red-700"
                  >
                    {summaryError}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              {actions.map((a) => (
                <button
                  key={a.to}
                  type="button"
                  disabled={busy}
                  className={a.to === 'OPEN' ? secondaryButton : primaryButton}
                  onClick={() => onStatus(a)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="conversation-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2 id="conversation-title" className="text-lg font-bold text-slate-950">
          Conversation and notes
        </h2>
        {ticket.comments.length === 0 ? (
          <p className="text-slate-600">No replies or notes yet.</p>
        ) : (
          <ul className="space-y-3">
            {ticket.comments.map((c) => (
              <li
                key={c.id}
                data-testid="comment"
                className={`rounded-xl border p-4 ${
                  c.isInternal ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
                }`}
              >
                <p className="text-sm font-medium">
                  {c.author.id === user?.id ? 'You' : c.author.name}
                  {c.isInternal && (
                    <span className="ml-2 rounded border border-amber-500 px-1.5 py-0.5 text-xs">
                      Internal note
                    </span>
                  )}
                  <span className="ml-2 font-normal text-slate-600">
                    <time dateTime={c.createdAt}>{formatDateTime(c.createdAt)}</time>
                  </span>
                </p>
                <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={onComment} noValidate className="space-y-3" aria-busy={busy}>
          <div>
            <label htmlFor="note" className="app-label">
              Add a note or reply
            </label>
            <textarea
              id="note"
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={`note-count${noteError ? ' note-error' : ''}`}
              className={inputClass}
            />
            {noteError && (
              <p id="note-error" role="alert" className="mt-1 text-sm font-medium text-red-700">
                {noteError}
              </p>
            )}
            <Counter id="note-count" length={note.trim().length} max={LIMITS.reply} />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
            />
            Internal note (staff only, hidden from the requester)
          </label>
          <button type="submit" disabled={busy} className={primaryButton}>
            {internal ? 'Add internal note' : 'Send reply'}
          </button>
        </form>
      </section>

      <section aria-labelledby="history-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2 id="history-title" className="text-lg font-bold text-slate-950">
          Audit timeline
        </h2>
        <ol className="space-y-2 border-l-2 border-slate-300 pl-4">
          {ticket.timeline.map((e) => (
            <li key={e.id} data-testid="timeline-entry" className="text-sm">
              <span className="font-medium">{describeStaffEvent(e)}</span>
              <span className="ml-2 text-slate-600">
                <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
