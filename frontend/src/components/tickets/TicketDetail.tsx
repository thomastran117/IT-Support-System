'use client';

import type { TicketDetailDto, TicketStatus } from '@smartdesk/contracts';
import { MessageSquareText, Send } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ApiError } from '@/lib/auth/client';
import { pollIntervalMs } from '@/lib/config';
import { ticketsApi } from '@/lib/tickets/api';
import {
  PRIORITY_LABEL,
  STATUS_HELP,
  STATUS_LABEL,
  STATUS_ORDER,
  describeError,
  describeEvent,
  formatDateTime,
} from '@/lib/tickets/format';
import { usePolling } from '@/lib/tickets/usePolling';
import { LIMITS, validateReply } from '@/lib/tickets/validation';
import { Counter, inputClass, primaryButton, secondaryButton, StatusBadge } from './ui';

function Stepper({ status }: { status: TicketStatus }) {
  const current = STATUS_ORDER.indexOf(status);
  return (
    <ol aria-label="Ticket progress" className="grid gap-2 sm:grid-cols-5">
      {STATUS_ORDER.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'upcoming';
        return (
          <li
            key={s}
            aria-current={state === 'current' ? 'step' : undefined}
            className={`rounded-xl border p-3 text-sm ${
              state === 'current'
                ? 'border-blue-300 bg-blue-50 font-semibold text-blue-900 shadow-sm'
                : state === 'done'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-slate-200 bg-white text-slate-500'
            }`}
          >
            <span className="block">{STATUS_LABEL[s]}</span>
            <span className="block text-xs font-normal">
              {state === 'done' ? 'Done' : state === 'current' ? 'Current' : 'Not yet'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get('created') === '1';
  const { api, user } = useAuth();
  const tickets = useMemo(() => ticketsApi(api), [api]);

  const [ticket, setTicket] = useState<TicketDetailDto | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const latest = useRef(0);
  const shownStatus = useRef<TicketStatus | null>(null);

  // `silent` refreshes (polling) keep the page as it is on failure instead of replacing it.
  const load = useCallback(
    async (silent = false) => {
      const request = ++latest.current;
      try {
        const next = await tickets.get(id);
        if (request !== latest.current) return; // an older response must not overwrite a newer one
        if (shownStatus.current && shownStatus.current !== next.status) {
          setAnnouncement(`Status updated to ${STATUS_LABEL[next.status]}.`);
        }
        shownStatus.current = next.status;
        setTicket(next);
        setLoadError(null);
        setRefreshFailed(false);
      } catch (err) {
        if (request !== latest.current) return;
        if (silent) {
          setRefreshFailed(true);
        } else {
          setLoadError({
            message: describeError(err, 'ticket'),
            notFound: err instanceof ApiError && err.status === 404,
          });
        }
      }
    },
    [tickets, id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Technician changes show up without a reload.
  usePolling(() => void load(true), pollIntervalMs(), ticket !== null);

  // Reply form
  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  async function onReply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sendingRef.current) return;
    const problem = validateReply(reply);
    setReplyError(problem);
    if (problem) {
      document.getElementById('reply')?.focus();
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      await tickets.reply(id, reply.trim());
      setReply('');
      await load(true);
    } catch (err) {
      // The text stays in the box so it can be sent again.
      setReplyError(describeError(err, 'ticket'));
      document.getElementById('reply')?.focus();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  if (loadError) {
    return (
      <section aria-labelledby="page-title" className="space-y-4">
        <h1 id="page-title" className="text-2xl font-semibold">
          {loadError.notFound ? 'Ticket not found' : 'Ticket unavailable'}
        </h1>
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-4 text-red-900">
          {loadError.message}
        </p>
        <div className="flex gap-3">
          {!loadError.notFound && (
            <button type="button" className={secondaryButton} onClick={() => void load()}>
              Try again
            </button>
          )}
          <Link href="/employee" className={secondaryButton}>
            Back to my tickets
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

  const done = ticket.status === 'RESOLVED' || ticket.status === 'CLOSED';

  return (
    <article aria-labelledby="page-title" className="space-y-6">
      <p className="text-sm">
        <Link href="/employee" className="app-button-quiet min-h-9 px-2 py-1.5">
          My tickets
        </Link>
      </p>

      {/* Live region: announces a status change that arrives while the page is open. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {created && (
        <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
          <p className="font-semibold">Your ticket was submitted.</p>
          <p className="mt-1">
            Your tracking ID is{' '}
            <code data-testid="tracking-id" className="break-all font-mono">
              {ticket.trackingId}
            </code>
            . Keep it if you need to ask about this ticket.
          </p>
        </div>
      )}

      {refreshFailed && (
        <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          Unable to check for updates right now. What you see may be out of date.{' '}
          <button type="button" className="underline" onClick={() => void load(true)}>
            Check again
          </button>
        </p>
      )}

      <header className="app-card space-y-3 p-5 sm:p-6">
        <h1 id="page-title" className="text-2xl font-bold tracking-[-0.025em] text-slate-950 sm:text-3xl">
          {ticket.title}
        </h1>
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={ticket.status} />
          <span>{STATUS_HELP[ticket.status]}</span>
        </p>
        <p className="text-sm text-slate-600">
          Tracking ID: <code className="break-all font-mono">{ticket.trackingId}</code>
        </p>
      </header>

      <Stepper status={ticket.status} />

      <section aria-labelledby="details-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2 id="details-title" className="text-lg font-bold text-slate-950">
          Details
        </h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium">Category</dt>
            <dd>{ticket.category?.name ?? 'Not set yet'}</dd>
          </div>
          <div>
            <dt className="font-medium">Support team</dt>
            <dd>{ticket.team?.name ?? 'Not assigned yet'}</dd>
          </div>
          <div>
            <dt className="font-medium">Priority</dt>
            <dd>{PRIORITY_LABEL[ticket.priority]}</dd>
          </div>
          <div>
            <dt className="font-medium">Technician</dt>
            <dd>{ticket.assignee?.name ?? 'Not assigned yet'}</dd>
          </div>
          <div>
            <dt className="font-medium">Submitted</dt>
            <dd>{formatDateTime(ticket.createdAt)}</dd>
          </div>
          <div>
            <dt className="font-medium">Last updated</dt>
            <dd>{formatDateTime(ticket.updatedAt)}</dd>
          </div>
        </dl>
        <div>
          <h3 className="font-medium">Your description</h3>
          <p className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-slate-700 ring-1 ring-slate-200">
            {ticket.description}
          </p>
        </div>
        {done && ticket.resolutionSummary && (
          <div>
            <h3 className="font-medium">Resolution</h3>
            <p className="mt-2 whitespace-pre-wrap rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
              {ticket.resolutionSummary}
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="conversation-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2 id="conversation-title" className="flex items-center gap-2 text-lg font-bold text-slate-950">
          <MessageSquareText aria-hidden="true" size={19} className="text-blue-700" />
          Conversation
        </h2>
        {ticket.comments.length === 0 ? (
          <p className="text-slate-600">No replies yet.</p>
        ) : (
          <ul className="space-y-3">
            {ticket.comments.map((c) => (
              <li
                key={c.id}
                data-testid="comment"
                className={`rounded-xl border p-4 ${
                  c.author.id === user?.id
                    ? 'border-blue-200 bg-blue-50'
                    : 'border-slate-200 bg-white'
                }`}
              >
                <p className="text-sm font-medium">
                  {c.author.id === user?.id ? 'You' : c.author.name}
                  <span className="ml-2 font-normal text-slate-600">
                    <time dateTime={c.createdAt}>{formatDateTime(c.createdAt)}</time>
                  </span>
                </p>
                <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={onReply} noValidate className="space-y-3" aria-busy={sending}>
          <div>
            <label htmlFor="reply" className="app-label">
              Reply
            </label>
            <textarea
              id="reply"
              rows={4}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              aria-invalid={replyError ? true : undefined}
              aria-describedby={`reply-count${replyError ? ' reply-error' : ''}`}
              className={inputClass}
            />
            {replyError && (
              <p id="reply-error" role="alert" className="mt-1 text-sm font-medium text-red-700">
                {replyError}
              </p>
            )}
            <Counter id="reply-count" length={reply.trim().length} max={LIMITS.reply} />
          </div>
          <button type="submit" disabled={sending} className={primaryButton}>
            <Send aria-hidden="true" size={16} />
            {sending ? 'Sending…' : 'Send reply'}
          </button>
        </form>
      </section>

      <section aria-labelledby="history-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2 id="history-title" className="text-lg font-bold text-slate-950">
          History
        </h2>
        <ol className="space-y-2 border-l-2 border-slate-300 pl-4">
          {ticket.timeline.map((e) => (
            <li key={e.id} data-testid="timeline-entry" className="text-sm">
              <span className="font-medium">{describeEvent(e)}</span>
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
