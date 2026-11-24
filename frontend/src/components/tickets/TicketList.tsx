'use client';

import type { TicketPage, TicketPriority, TicketStatus } from '@smartdesk/contracts';
import { Plus } from 'lucide-react';
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
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Pagination,
  PriorityBadge,
} from '@/components/ui';
import { inputClass, primaryButton, secondaryButton, StatusBadge } from './ui';
import { TicketSearch } from './TicketSearch';

const PAGE_SIZE = 10;
const PRIORITIES = Object.keys(PRIORITY_LABEL) as TicketPriority[];

export function TicketList({ admin = false }: { admin?: boolean }) {
  const detailPath = admin ? '/admin/tickets' : '/employee/tickets';
  return (
    <section aria-labelledby="page-title" className="space-y-5">
      <PageHeader
        title={admin ? 'Tickets' : 'My tickets'}
        actions={
          admin ? undefined : (
            <Link href="/employee/tickets/new" className={primaryButton}>
              <Plus aria-hidden="true" size={17} /> New ticket
            </Link>
          )
        }
      />
      <TicketSearch
        detailPath={detailPath}
        browseLabel={admin ? 'Browse tickets' : 'Browse my tickets'}
      >
        <TicketBrowseList admin={admin} detailPath={detailPath} />
      </TicketSearch>
    </section>
  );
}

function TicketBrowseList({ admin, detailPath }: { admin: boolean; detailPath: string }) {
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
  const resetFilters = () => {
    setStatus('');
    setPriority('');
    setOffset(0);
  };

  return (
    <>
      <form
        aria-label="Filter tickets"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="grid w-full gap-3 min-[360px]:grid-cols-2 sm:w-auto sm:min-w-88">
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
        {filtered && (
          <button type="button" onClick={resetFilters} className="app-button-quiet">
            Clear
          </button>
        )}
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
            filtered
              ? 'No tickets match these filters.'
              : admin
                ? 'No tickets yet.'
                : 'You have not submitted any tickets yet.'
          }
          description={
            filtered
              ? 'Try clearing a filter to see more results.'
              : admin
                ? undefined
                : 'When equipment, software, or access gets in your way, create a support request here.'
          }
          action={
            filtered ? (
              <button type="button" onClick={resetFilters} className={secondaryButton}>
                Clear filters
              </button>
            ) : admin ? undefined : (
              <Link href="/employee/tickets/new" className={primaryButton}>
                <Plus aria-hidden="true" size={17} />
                New ticket
              </Link>
            )
          }
        />
      )}

      {page && page.items.length > 0 && (
        <div
          aria-busy={loading}
          className="app-card min-w-0 md:overflow-hidden max-md:border-0 max-md:bg-transparent max-md:shadow-none"
        >
          <table className="app-table app-table-compact responsive-table">
            <caption className="sr-only">
              {admin ? 'Tickets, newest first' : 'Your tickets, newest first'}
            </caption>
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
                    className="font-mono text-xs text-muted"
                    title={ticket.trackingId}
                  >
                    {shortId(ticket.trackingId)}
                  </td>
                  <th scope="row" data-primary="true" className="font-semibold text-ink-strong">
                    <Link
                      href={`${detailPath}/${ticket.id}`}
                      className="hover:text-accent hover:underline"
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
                  <td data-label="Submitted" className="text-muted">
                    {formatDateTime(ticket.createdAt)}
                  </td>
                  <td data-label="Updated" className="text-muted">
                    {formatDateTime(ticket.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-line p-3 max-md:mt-3 max-md:rounded-lg max-md:border max-md:bg-panel">
            <Pagination
              offset={page.offset}
              limit={PAGE_SIZE}
              count={page.items.length}
              total={page.total}
              nextOffset={page.nextOffset}
              busy={loading}
              onChange={setOffset}
            />
          </div>
        </div>
      )}
    </>
  );
}
