'use client';

import type { CategoryRefDto, QueuePage, TeamRefDto, TicketPriority } from '@smartdesk/contracts';
import { Layers3, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { EmptyState, PageHeader, Pagination, PriorityBadge } from '@/components/ui';
import { ApiError } from '@/lib/auth/client';
import { PRIORITY_LABEL } from '@/lib/tickets/format';
import { technicianApi } from '@/lib/technician/api';
import { formatAge, APPROVABLE } from '@/lib/technician/format';
import { inputClass, secondaryButton, StatusBadge } from '../tickets/ui';
import { TicketSearch } from '../tickets/TicketSearch';

type Tab = 'unassigned' | 'team' | 'mine';

const TABS: { id: Tab; label: string; help: string }[] = [
  { id: 'unassigned', label: 'Unassigned', help: 'Open tickets nobody has routed yet.' },
  { id: 'team', label: 'Team queue', help: 'Unresolved tickets of a support team.' },
  { id: 'mine', label: 'Assigned to me', help: 'Unresolved tickets assigned to you in a team.' },
];

const PAGE_SIZE = 10;

function describeQueueError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have access to this queue.';
    if (err.status === 404) return 'This queue could not be found.';
    if (err.status === 400) return 'Those filters were not accepted. Reset the filters and retry.';
    if (err.status === 401) return 'Your session has ended. Please sign in again.';
  }
  return 'Unable to load the queue. Check your connection and try again.';
}

export function TechnicianDashboard() {
  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <PageHeader
        eyebrow="Technician workspace"
        title="Technician dashboard"
        description="Triage incoming requests, manage team workload, and keep service moving."
      />
      <TicketSearch detailPath="/technician/tickets" browseLabel="Back to the support queue">
        <TechnicianQueues />
      </TicketSearch>
    </section>
  );
}

function TechnicianQueues() {
  const { api } = useAuth();
  const tech = useMemo(() => technicianApi(api), [api]);

  const [tab, setTab] = useState<Tab>('unassigned');
  const [teams, setTeams] = useState<TeamRefDto[] | null>(null);
  const [categories, setCategories] = useState<CategoryRefDto[]>([]);
  const [teamId, setTeamId] = useState('');
  const [priority, setPriority] = useState<TicketPriority | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const [offset, setOffset] = useState(0);

  const [page, setPage] = useState<QueuePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  // Reference data for the filters. A failure here must not stop the queue from loading.
  useEffect(() => {
    let cancelled = false;
    void tech
      .myTeams()
      .then((t) => {
        if (cancelled) return;
        setTeams(t);
        setTeamId((current) => current || t[0]?.id || '');
      })
      .catch(() => !cancelled && setTeams([]));
    void tech
      .categories()
      .then((c) => !cancelled && setCategories(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tech]);

  const needsTeam = tab !== 'unassigned';
  // The backlog is not team-scoped, so a team arriving late must not trigger a second fetch of it.
  const scopeTeamId = needsTeam ? teamId : '';

  const load = useCallback(async () => {
    if (needsTeam && !scopeTeamId) {
      setPage(null);
      setLoading(false);
      return;
    }
    const request = ++latest.current;
    setLoading(true);
    const filters = {
      priority: priority ? [priority] : undefined,
      categoryId: categoryId || undefined,
      limit: PAGE_SIZE,
      offset,
    };
    try {
      const result =
        tab === 'unassigned'
          ? await tech.unassigned(filters)
          : await tech.teamQueue(scopeTeamId, { ...filters, mine: tab === 'mine' });
      if (request !== latest.current) return; // a newer request superseded this one
      setPage(result);
      setError(null);
    } catch (err) {
      if (request !== latest.current) return;
      setPage(null);
      setError(describeQueueError(err));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [tech, tab, scopeTeamId, priority, categoryId, offset, needsTeam]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = priority !== '' || categoryId !== '';
  const active = TABS.find((t) => t.id === tab)!;
  const noTeams = teams !== null && teams.length === 0 && needsTeam;

  return (
    <>
      <div
        role="tablist"
        aria-label="Queues"
        className="app-card flex flex-wrap gap-1.5 p-1.5 sm:w-fit"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="queue-panel"
            onClick={() => {
              setTab(t.id);
              setOffset(0);
            }}
            className={`min-h-10 flex-1 rounded-lg border px-4 py-2 text-sm sm:flex-none ${
              tab === t.id
                ? 'border-blue-200 bg-blue-50 font-semibold text-blue-800 shadow-sm'
                : 'border-transparent bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="queue-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="space-y-5">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Layers3 aria-hidden="true" size={17} className="text-blue-700" />
          <p>{active.help}</p>
        </div>

        <form
          aria-label="Filter queue"
          className="app-card p-4 sm:p-5"
          onSubmit={(e) => e.preventDefault()}
        >
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <SlidersHorizontal aria-hidden="true" size={17} className="text-blue-700" />
            Filter queue
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:max-w-4xl xl:grid-cols-3">
            {needsTeam && (
              <div>
                <label htmlFor="filter-team" className="app-label">
                  Team
                </label>
                <select
                  id="filter-team"
                  value={teamId}
                  onChange={(e) => {
                    setTeamId(e.target.value);
                    setOffset(0);
                  }}
                  className={inputClass}
                >
                  {(teams ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="filter-priority" className="app-label">
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
                {[...APPROVABLE].reverse().map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
                <option value="UNSET">{PRIORITY_LABEL.UNSET}</option>
              </select>
            </div>
            <div>
              <label htmlFor="filter-category" className="app-label">
                Category
              </label>
              <select
                id="filter-category"
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setOffset(0);
                }}
                className={inputClass}
              >
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </form>

        {noTeams && (
          <p role="status" className="app-card p-5 text-slate-700">
            You are not a member of any support team yet, so there is no team queue to show. Ask an
            administrator to add you to a team.
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-950"
          >
            <p>{error}</p>
            <button type="button" onClick={() => void load()} className={`${secondaryButton} mt-3`}>
              Try again
            </button>
          </div>
        )}

        {loading && !page && !error && !noTeams && (
          <p role="status" className="text-slate-600">
            Loading the queue…
          </p>
        )}

        {page && page.items.length === 0 && !error && (
          <EmptyState
            title={filtered ? 'No tickets match these filters.' : 'This queue is empty.'}
            description={
              filtered
                ? 'Adjust the filters to broaden the results.'
                : 'New requests will appear here as they arrive.'
            }
          />
        )}

        {page && page.items.length > 0 && (
          <div aria-busy={loading}>
            <div className="app-card overflow-hidden">
              <table className="app-table responsive-table">
                <caption className="sr-only">{active.label}, most urgent first</caption>
                <thead className="bg-slate-50">
                  <tr>
                    <th scope="col" className="p-2">
                      Priority
                    </th>
                    <th scope="col" className="p-2">
                      Ticket
                    </th>
                    <th scope="col" className="p-2">
                      Status
                    </th>
                    <th scope="col" className="p-2">
                      Category
                    </th>
                    <th scope="col" className="p-2">
                      Assignee
                    </th>
                    <th scope="col" className="p-2">
                      Age
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((t) => (
                    <tr key={t.id} className="border-t border-slate-200">
                      <td data-label="Priority" data-secondary="true">
                        <PriorityBadge priority={t.priority} />
                      </td>
                      <th scope="row" data-primary="true" className="font-semibold text-slate-950">
                        <Link
                          href={`/technician/tickets/${t.id}`}
                          className="hover:text-blue-700 hover:underline"
                        >
                          {t.title}
                        </Link>
                      </th>
                      <td data-label="Status">
                        <StatusBadge status={t.status} />
                      </td>
                      <td data-label="Category">{t.category?.name ?? 'Not set'}</td>
                      <td data-label="Assignee">{t.assignee?.name ?? 'Unassigned'}</td>
                      <td data-label="Age" title={`${t.ageMinutes} minutes`}>
                        {formatAge(t.ageMinutes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4">
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
      </div>
    </>
  );
}
