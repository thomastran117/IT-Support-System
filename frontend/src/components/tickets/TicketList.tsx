'use client';

import type { TicketPage, TicketPriority, TicketStatus } from '@smartdesk/contracts';
import { Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ticketsApi } from '@/lib/tickets/api';
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  describeError,
  formatDateTime,
  shortId,
} from '@/lib/tickets/format';
import { EmptyState, ErrorState, LoadingState, PageHeader, PriorityBadge } from '@/components/ui';
import { inputClass, primaryButton, secondaryButton, StatusBadge } from './ui';

const PAGE_SIZE = 10;
const PRIORITIES = Object.keys(PRIORITY_LABEL) as TicketPriority[];

export function TicketList() {
  const { api } = useAuth();
  const tickets = useMemo(() => ticketsApi(api), [api]);
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [priority, setPriority] = useState<TicketPriority | ''>('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<TicketPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const result = await tickets.list({
        status: status || undefined,
        priority: priority || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      if (request !== latest.current) return;
      setPage(result);
      setError(null);
    } catch (err) {
      if (request !== latest.current) return;
      setError(describeError(err, 'list'));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [tickets, status, priority, offset]);

  useEffect(() => void load(), [load]);

  const filtered = status !== '' || priority !== '';
  const first = page && page.items.length > 0 ? page.offset + 1 : 0;
  const last = page ? page.offset + page.items.length : 0;
  const resetFilters = () => {
    setStatus('');
    setPriority('');
    setOffset(0);
  };

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <PageHeader
        eyebrow="Employee workspace"
        title="My tickets"
        description="Track every request, response, and resolution in one place."
        actions={
          <Link href="/employee/tickets/new" className={primaryButton}>
            <Plus aria-hidden="true" size={17} />
            New ticket
          </Link>
        }
      />

      <form
        aria-label="Filter tickets"
        className="app-card p-4 sm:p-5"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <SlidersHorizontal aria-hidden="true" size={17} className="text-blue-700" />
            Filter tickets
          </div>
          {filtered && (
            <button
              type="button"
              onClick={resetFilters}
              className="app-button-quiet min-h-9 px-2.5 py-1.5"
            >
              <RotateCcw aria-hidden="true" size={14} />
              Clear
            </button>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
          <div>
            <label htmlFor="filter-status" className="app-label">
              Status
            </label>
            <select
              id="filter-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as TicketStatus | '');
                setOffset(0);
              }}
              className={inputClass}
            >
              <option value="">All statuses</option>
              {STATUS_ORDER.map((item) => (
                <option key={item} value={item}>
                  {STATUS_LABEL[item]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="filter-priority" className="app-label">
              Priority
            </label>
            <select
              id="filter-priority"
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value as TicketPriority | '');
                setOffset(0);
              }}
              className={inputClass}
            >
              <option value="">All priorities</option>
              {PRIORITIES.map((item) => (
                <option key={item} value={item}>
                  {PRIORITY_LABEL[item]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </form>

      {error && (
        <ErrorState
          message={error}
          action={
            <button type="button" onClick={() => void load()} className={secondaryButton}>
              Try again
            </button>
          }
        />
      )}
      {loading && !page && !error && <LoadingState label="Loading your tickets…" />}

      {page && page.items.length === 0 && !error && (
        <EmptyState
          title={
            filtered ? 'No tickets match these filters.' : 'You have not submitted any tickets yet.'
          }
          description={
            filtered
              ? 'Try clearing a filter to see more results.'
              : 'When equipment, software, or access gets in your way, create a support request here.'
          }
          action={
            filtered ? (
              <button type="button" onClick={resetFilters} className={secondaryButton}>
                Clear filters
              </button>
            ) : (
              <Link href="/employee/tickets/new" className={primaryButton}>
                <Plus aria-hidden="true" size={17} />
                New ticket
              </Link>
            )
          }
        />
      )}

      {page && page.items.length > 0 && (
        <div aria-busy={loading} className="space-y-4">
          <div className="app-card overflow-hidden">
            <table className="app-table responsive-table">
              <caption className="sr-only">Your tickets, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((ticket) => (
                  <tr key={ticket.id}>
                    <td
                      data-label="Ticket"
                      data-secondary="true"
                      className="font-mono text-xs text-slate-500"
                      title={ticket.trackingId}
                    >
                      {shortId(ticket.trackingId)}
                    </td>
                    <th scope="row" data-primary="true" className="font-semibold text-slate-950">
                      <Link
                        href={`/employee/tickets/${ticket.id}`}
                        className="hover:text-blue-700 hover:underline"
                      >
                        {ticket.title}
                      </Link>
                    </th>
                    <td data-label="Status">
                      <StatusBadge status={ticket.status} />
                    </td>
                    <td data-label="Priority">
                      <PriorityBadge priority={ticket.priority} />
                    </td>
                    <td data-label="Submitted" className="text-slate-600">
                      {formatDateTime(ticket.createdAt)}
                    </td>
                    <td data-label="Updated" className="text-slate-600">
                      {formatDateTime(ticket.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Pagination" className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={secondaryButton}
              disabled={loading || page.offset === 0}
              onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={loading || page.nextOffset === null}
              onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}
            >
              Next
            </button>
            <p role="status" className="ml-auto text-sm text-slate-500">
              Showing {first}–{last} of {page.total}
            </p>
          </nav>
        </div>
      )}
    </section>
  );
}
