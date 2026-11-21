'use client';

import type { TicketPage, TicketPriority, TicketStatus } from '@smartdesk/contracts';
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
      if (request !== latest.current) return; // a newer request superseded this one
      setPage(result);
      setError(null);
    } catch (err) {
      if (request !== latest.current) return;
      setError(describeError(err, 'list'));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [tickets, status, priority, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = status !== '' || priority !== '';
  const first = page && page.items.length > 0 ? page.offset + 1 : 0;
  const last = page ? page.offset + page.items.length : 0;

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="page-title" className="text-2xl font-semibold">
          My tickets
        </h1>
        <Link href="/employee/tickets/new" className={primaryButton}>
          New ticket
        </Link>
      </div>

      <form
        aria-label="Filter tickets"
        className="flex flex-wrap items-end gap-4"
        onSubmit={(e) => e.preventDefault()}
      >
        <div>
          <label htmlFor="filter-status" className="block text-sm font-medium">
            Status
          </label>
          <select
            id="filter-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as TicketStatus | '');
              setOffset(0);
            }}
            className={inputClass}
          >
            <option value="">All statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-priority" className="block text-sm font-medium">
            Priority
          </label>
          <select
            id="filter-priority"
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value as TicketPriority | '');
              setOffset(0);
            }}
            className={inputClass}
          >
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
      </form>

      {error && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-4 text-red-900">
          <p>{error}</p>
          <button type="button" onClick={() => void load()} className={`${secondaryButton} mt-3`}>
            Try again
          </button>
        </div>
      )}

      {loading && !page && !error && (
        <p role="status" className="text-slate-600">
          Loading your tickets…
        </p>
      )}

      {page && page.items.length === 0 && !error && (
        <div className="rounded border border-slate-200 bg-white p-6 text-center">
          <p className="font-medium">
            {filtered
              ? 'No tickets match these filters.'
              : 'You have not submitted any tickets yet.'}
          </p>
          {!filtered && (
            <p className="mt-2 text-slate-600">
              When something is wrong with your equipment or access,{' '}
              <Link href="/employee/tickets/new" className="underline">
                submit a ticket
              </Link>
              .
            </p>
          )}
        </div>
      )}

      {page && page.items.length > 0 && (
        <div aria-busy={loading}>
          <div className="overflow-x-auto rounded border border-slate-200 bg-white">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <caption className="sr-only">Your tickets, newest first</caption>
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="p-2">
                    Ticket
                  </th>
                  <th scope="col" className="p-2">
                    Title
                  </th>
                  <th scope="col" className="p-2">
                    Status
                  </th>
                  <th scope="col" className="p-2">
                    Priority
                  </th>
                  <th scope="col" className="p-2">
                    Submitted
                  </th>
                  <th scope="col" className="p-2">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((t) => (
                  <tr key={t.id} className="border-t border-slate-200">
                    <td className="p-2 font-mono text-xs" title={t.trackingId}>
                      {shortId(t.trackingId)}
                    </td>
                    <th scope="row" className="p-2 font-medium">
                      <Link href={`/employee/tickets/${t.id}`} className="underline">
                        {t.title}
                      </Link>
                    </th>
                    <td className="p-2">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="p-2">{PRIORITY_LABEL[t.priority]}</td>
                    <td className="p-2">{formatDateTime(t.createdAt)}</td>
                    <td className="p-2">{formatDateTime(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center gap-3">
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
            <p role="status" className="text-sm text-slate-600">
              Showing {first}–{last} of {page.total}
            </p>
          </nav>
        </div>
      )}
    </section>
  );
}
