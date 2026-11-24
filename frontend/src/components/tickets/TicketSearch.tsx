'use client';

import {
  TICKET_SEARCH_QUERY_MAX,
  ticketSearchUnavailableSchema,
  type TicketSearchResponse,
} from '@smartdesk/contracts';
import { Search, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState, PriorityBadge } from '@/components/ui';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ApiError, errorKind } from '@/lib/auth/client';
import { ticketsApi } from '@/lib/tickets/api';
import { formatDateTime } from '@/lib/tickets/format';
import {
  ticketSearchFilters,
  ticketSearchHref,
  ticketSearchRequest,
  type TicketSearchFilter,
} from '@/lib/tickets/search';
import { TicketSearchFilters } from './TicketSearchFilters';
import { inputClass, primaryButton, secondaryButton, StatusBadge } from './ui';

interface Props {
  detailPath: string;
  browseLabel: string;
  children: ReactNode;
}

type Result = { key: string } & (
  | { kind: 'ready'; page: TicketSearchResponse }
  | { kind: 'unavailable'; disabled: boolean }
  | { kind: 'error'; message: string; restart: boolean }
);

function searchFailure(
  err: unknown,
  hasCursor: boolean,
): Omit<Extract<Result, { kind: 'error' }>, 'key'> {
  if (err instanceof ApiError && err.code === 'TICKET_SEARCH_RESTART') {
    return {
      kind: 'error',
      message: 'The search engine changed. Go to the first page to continue.',
      restart: true,
    };
  }
  switch (errorKind(err)) {
    case 'validation':
      return {
        kind: 'error',
        message: hasCursor
          ? 'This search page has expired. Go to the first page to continue.'
          : 'Check your search and filters, then try again.',
        restart: hasCursor,
      };
    case 'forbidden':
      return {
        kind: 'error',
        message: 'A search filter is outside your access. Reset the filters to continue.',
        restart: false,
      };
    case 'rate_limited':
      return {
        kind: 'error',
        message: 'Too many searches. Wait a minute, then try again.',
        restart: false,
      };
    default:
      return {
        kind: 'error',
        message: 'Unable to load ticket search. Check your connection and try again.',
        restart: false,
      };
  }
}

function searchStatus(page: TicketSearchResponse, continuing: boolean) {
  if (page.mode === 'text') return 'Recently changed tickets may take time to appear.';
  if (page.mode === 'exact') return '';
  if (continuing) return 'Showing current PostgreSQL results for this search.';
  if (page.reason === 'index_lag')
    return 'The search index is catching up. Showing current PostgreSQL results.';
  if (page.reason === 'unavailable')
    return 'The search index is unavailable. Showing current PostgreSQL results.';
  return 'Showing current PostgreSQL results.';
}

function Panel({ detailPath, browseLabel, children }: Props) {
  const pathname = usePathname();
  const rawParams = useSearchParams().toString();
  const params = useMemo(() => new URLSearchParams(rawParams), [rawParams]);
  const q = params.get('q')?.trim() ?? '';
  const cursor = params.get('cursor');
  const activeFilters = ticketSearchFilters.some((filter) => params.has(filter));
  const { api, user } = useAuth();
  const tickets = useMemo(() => ticketsApi(api), [api]);
  const [draft, setDraft] = useState({ q, text: q });
  // A URL change from Back, Forward or a link also resets the input draft.
  if (draft.q !== q) setDraft({ q, text: q });
  const text = draft.q === q ? draft.text : q;
  const editing = text.trim() !== q;
  const [expanded, setExpanded] = useState(activeFilters);
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Result | null>(null);
  const inputId = useId();
  const filterId = useId();
  const request = useMemo(() => ticketSearchRequest(params), [params]);
  const key = JSON.stringify([user?.id, user?.role, rawParams, attempt]);
  const current = outcome?.key === key && !editing ? outcome : null;

  function navigate(next: URLSearchParams) {
    const href = ticketSearchHref(pathname, next);
    if (href !== `${window.location.pathname}${window.location.search}`)
      window.history.pushState(null, '', href);
  }

  function submitText() {
    const next = new URLSearchParams(window.location.search);
    if (editing) next.delete('cursor');
    next.set('q', text.trim());
    navigate(next);
  }

  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(rawParams);
      next.set('q', text.trim());
      next.delete('cursor');
      window.history.pushState(null, '', ticketSearchHref(pathname, next));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [editing, pathname, rawParams, text]);

  useEffect(() => {
    if (!q || editing || !request || !user) return;
    const controller = new AbortController();
    void tickets
      .search(request, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setOutcome({ key, kind: 'ready', page });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const unavailable =
          err instanceof ApiError &&
          err.status === 503 &&
          ticketSearchUnavailableSchema.safeParse(err.details);
        setOutcome(
          unavailable && unavailable.success
            ? {
                key,
                kind: 'unavailable',
                disabled: unavailable.data.code === 'TICKET_SEARCH_DISABLED',
              }
            : { key, ...searchFailure(err, !!cursor) },
        );
      });
    return () => controller.abort();
  }, [q, cursor, editing, request, key, tickets, user]);

  function changeFilters(changes: Partial<Record<TicketSearchFilter, string>>) {
    const next = new URLSearchParams(window.location.search);
    next.set('q', text.trim());
    next.delete('cursor');
    for (const [filter, value] of Object.entries(changes)) {
      if (value) next.set(filter, value);
      else next.delete(filter);
    }
    navigate(next);
  }

  function clear() {
    setDraft({ q, text: '' });
    setExpanded(false);
    navigate(new URLSearchParams());
  }

  function goToPage(nextCursor?: string) {
    const next = new URLSearchParams(rawParams);
    if (nextCursor) next.set('cursor', nextCursor);
    else next.delete('cursor');
    navigate(next);
  }

  const searching = !!(q || text.trim());
  const filtersVisible = expanded && !!text.trim();
  const retry = () => setAttempt((count) => count + 1);
  return (
    <>
      <form
        role="search"
        aria-label="Ticket search"
        className="app-card space-y-3 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          submitText();
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-[1_1_15rem]">
            <label className="app-label" htmlFor={inputId}>
              Search tickets
            </label>
            <input
              id={inputId}
              name="q"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              maxLength={TICKET_SEARCH_QUERY_MAX}
              value={text}
              onChange={(e) => setDraft({ q, text: e.target.value })}
              placeholder="Title, description, or tracking ID"
              className={inputClass}
            />
          </div>
          <button type="submit" className={primaryButton} disabled={!text.trim()}>
            <Search aria-hidden="true" size={16} />
            Search
          </button>
          {searching && (
            <button
              type="button"
              className={secondaryButton}
              aria-expanded={filtersVisible}
              aria-controls={filtersVisible ? filterId : undefined}
              onClick={() => setExpanded(!filtersVisible)}
            >
              <SlidersHorizontal aria-hidden="true" size={16} /> Filters
            </button>
          )}
          {searching && (
            <button type="button" className="app-button-quiet" onClick={clear}>
              Clear search
            </button>
          )}
        </div>
        {filtersVisible && user && (
          <TicketSearchFilters
            id={filterId}
            user={user}
            params={params}
            change={changeFilters}
            active={activeFilters}
            reset={() =>
              changeFilters(Object.fromEntries(ticketSearchFilters.map((filter) => [filter, ''])))
            }
          />
        )}
      </form>

      <div hidden={searching} className="space-y-6">
        {children}
      </div>
      {!searching ? null : editing || (request && !current) ? (
        <LoadingState label="Searching tickets" />
      ) : !request ? (
        <ErrorState message="Check your search and date range. Enter at least one letter or number." />
      ) : current?.kind === 'unavailable' ? (
        <ErrorState
          message={
            current.disabled
              ? 'Text search is disabled. You can still search by tracking ID.'
              : 'Text search is temporarily unavailable. You can still search by tracking ID.'
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" className={secondaryButton} onClick={clear}>
                {browseLabel}
              </button>
              {!current.disabled && (
                <button type="button" className={secondaryButton} onClick={retry}>
                  Try again
                </button>
              )}
            </div>
          }
        />
      ) : current?.kind === 'error' ? (
        <ErrorState
          message={current.message}
          action={
            <button
              type="button"
              className={secondaryButton}
              onClick={current.restart ? () => goToPage() : retry}
            >
              {current.restart ? 'First page' : 'Try again'}
            </button>
          }
        />
      ) : current?.kind === 'ready' ? (
        <div className="space-y-4">
          <p role="status" className="text-sm text-slate-600">
            {current.page.items.length} {current.page.items.length === 1 ? 'result' : 'results'} on
            this page. {searchStatus(current.page, !!cursor)}
          </p>
          {current.page.items.length === 0 ? (
            <EmptyState
              title="No tickets match this search"
              description="Try different words, a tracking ID, or fewer filters."
            />
          ) : (
            <ul aria-label="Ticket search results" className="grid gap-3">
              {current.page.items.map((ticket) => (
                <li key={ticket.id} className="app-card space-y-2 p-4 sm:p-5">
                  <h2 className="break-words font-semibold text-slate-950">
                    <Link
                      href={ticketSearchHref(
                        `${detailPath}/${encodeURIComponent(ticket.id)}`,
                        params,
                      )}
                      className="underline-offset-4 hover:text-blue-700 hover:underline"
                    >
                      {ticket.title}
                    </Link>
                  </h2>
                  <p className="break-all font-mono text-xs text-slate-600">{ticket.trackingId}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-600">
                    <StatusBadge status={ticket.status} />
                    <PriorityBadge priority={ticket.priority} />
                    <span>{ticket.team?.name ?? 'Unrouted'}</span>
                    <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {(cursor || current.page.nextCursor) && (
            <nav aria-label="Search pagination" className="flex flex-wrap gap-2">
              {cursor && (
                <button type="button" className={secondaryButton} onClick={() => goToPage()}>
                  First page
                </button>
              )}
              {current.page.nextCursor && (
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => goToPage(current.page.nextCursor ?? undefined)}
                >
                  Next page
                </button>
              )}
            </nav>
          )}
        </div>
      ) : null}
    </>
  );
}

export function TicketSearch(props: Props) {
  return (
    <Suspense fallback={<LoadingState label="Loading tickets" />}>
      <Panel {...props} />
    </Suspense>
  );
}
