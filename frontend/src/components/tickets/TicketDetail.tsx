'use client';

import type { TicketDetailDto, TicketStatus } from '@smartdesk/contracts';
import { MessageSquareText, Send } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { PriorityBadge } from '@/components/ui';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ApiError } from '@/lib/auth/client';
import { pollIntervalMs } from '@/lib/config';
import { ticketsApi } from '@/lib/tickets/api';
import { ticketSearchHref } from '@/lib/tickets/search';
import {
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
                ? 'border-accent-line bg-accent-soft font-semibold text-accent shadow-sm'
                : state === 'done'
                  ? 'border-success-line bg-success-soft text-success'
                  : 'border-line bg-panel text-muted'
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
  const params = useSearchParams();
  const created = params.get('created') === '1';
  const backHref = ticketSearchHref('/employee', params);
  const fromSearch = backHref !== '/employee';
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
        <p
          role="alert"
          className="rounded border border-danger-line bg-danger-soft p-4 text-danger"
        >
          {loadError.message}
        </p>
        <div className="flex gap-3">
          {!loadError.notFound && (
            <button type="button" className={secondaryButton} onClick={() => void load()}>
              Try again
            </button>
          )}
          <Link href={backHref} className={secondaryButton}>
            {fromSearch ? 'Back to search results' : 'Back to my tickets'}
          </Link>
        </div>
      </section>
    );
  }

  if (!ticket) {
    return (
      <p role="status" className="text-muted">
        Loading ticket…
      </p>
    );
  }

  const done = ticket.status === 'RESOLVED' || ticket.status === 'CLOSED';

  return (
    <article aria-labelledby="page-title" className="space-y-6">
      <p className="text-sm">
        <Link href={backHref} className="app-button-quiet min-h-9 px-2 py-1.5">
          {fromSearch ? 'Back to search results' : 'My tickets'}
        </Link>
      </p>

      {/* Live region: announces a status change that arrives while the page is open. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {created && (
        <div
          role="status"
          className="rounded-xl border border-success-line bg-success-soft p-4 text-success"
        >
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
        <p
          role="status"
          className="rounded-xl border border-warning-line bg-warning-soft p-4 text-sm text-warning"
        >
          Unable to check for updates right now. What you see may be out of date.{' '}
          <button type="button" className="underline" onClick={() => void load(true)}>
            Check again
          </button>
        </p>
      )}

      <header className="space-y-3">
        <h1
          id="page-title"
          className="text-3xl font-semibold tracking-tight wrap-anywhere text-ink-strong sm:text-4xl"
        >
          {ticket.title}
        </h1>
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={ticket.status} />
          <span>{STATUS_HELP[ticket.status]}</span>
        </p>
        <p className="text-sm text-muted">
          Tracking ID: <code className="break-all font-mono">{ticket.trackingId}</code>
        </p>
      </header>

      <Stepper status={ticket.status} />

      <section aria-labelledby="details-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2 id="details-title" className="text-lg font-bold text-ink-strong">
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
            <dd>
              <PriorityBadge priority={ticket.priority} />
            </dd>
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
          <p className="mt-2 whitespace-pre-wrap rounded-xl bg-panel-muted p-4 text-muted-strong ring-1 ring-line">
            {ticket.description}
          </p>
        </div>
        {done && ticket.resolutionSummary && (
          <div>
            <h3 className="font-medium">Resolution</h3>
            <p className="mt-2 whitespace-pre-wrap rounded-xl border border-success-line bg-success-soft p-4 text-success">
              {ticket.resolutionSummary}
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="conversation-title" className="app-card space-y-4 p-5 sm:p-6">
        <h2
          id="conversation-title"
          className="flex items-center gap-2 text-lg font-bold text-ink-strong"
        >
          <MessageSquareText aria-hidden="true" size={19} className="text-accent" />
          Conversation
        </h2>
        {ticket.comments.length === 0 ? (
          <p className="text-muted">No replies yet.</p>
        ) : (
          <ul className="space-y-3">
            {ticket.comments.map((c) => (
              <li
                key={c.id}
                data-testid="comment"
                className={`rounded-xl border p-4 ${
                  c.author.id === user?.id
                    ? 'border-accent-line bg-accent-soft'
                    : 'border-line bg-panel'
                }`}
              >
                <p className="text-sm font-medium">
                  {c.author.id === user?.id ? 'You' : c.author.name}
                  <span className="ml-2 font-normal text-muted">
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
              <p id="reply-error" role="alert" className="mt-1 text-sm font-medium text-danger">
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
        <h2 id="history-title" className="text-lg font-bold text-ink-strong">
          History
        </h2>
        <ol className="space-y-2 border-l-2 border-line-strong pl-4">
          {ticket.timeline.map((e) => (
            <li key={e.id} data-testid="timeline-entry" className="text-sm">
              <span className="font-medium">{describeEvent(e)}</span>
              <span className="ml-2 text-muted">
                <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
