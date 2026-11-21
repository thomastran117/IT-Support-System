'use client';

import type { CategoryRefDto, QueuePage, TeamRefDto, TicketPriority } from '@smartdesk/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ApiError } from '@/lib/auth/client';
import { PRIORITY_LABEL } from '@/lib/tickets/format';
import { technicianApi } from '@/lib/technician/api';
import { formatAge, APPROVABLE } from '@/lib/technician/format';
import { inputClass, secondaryButton, StatusBadge } from '../tickets/ui';
import { PriorityChip } from './PriorityChip';

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
  const first = page && page.items.length > 0 ? page.offset + 1 : 0;
  const last = page ? page.offset + page.items.length : 0;
  const active = TABS.find((t) => t.id === tab)!;
  const noTeams = teams !== null && teams.length === 0 && needsTeam;

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold">
        Technician dashboard
      </h1>

      <div role="tablist" aria-label="Queues" className="flex flex-wrap gap-2">
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
            className={`rounded border px-4 py-2 ${
              tab === t.id
                ? 'border-blue-600 bg-blue-50 font-semibold'
                : 'border-slate-300 bg-white hover:bg-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="queue-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="space-y-4">
        <p className="text-sm text-slate-600">{active.help}</p>

        <form
          aria-label="Filter queue"
          className="flex flex-wrap items-end gap-4"
          onSubmit={(e) => e.preventDefault()}
        >
          {needsTeam && (
            <div>
              <label htmlFor="filter-team" className="block text-sm font-medium">
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
              {[...APPROVABLE].reverse().map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
              <option value="UNSET">{PRIORITY_LABEL.UNSET}</option>
            </select>
          </div>
          <div>
            <label htmlFor="filter-category" className="block text-sm font-medium">
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
        </form>

        {noTeams && (
          <p role="status" className="rounded border border-slate-200 bg-white p-4">
            You are not a member of any support team yet, so there is no team queue to show. Ask an
            administrator to add you to a team.
          </p>
        )}

        {error && (
          <div role="alert" className="rounded border border-red-300 bg-red-50 p-4 text-red-900">
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
          <div className="rounded border border-slate-200 bg-white p-6 text-center">
            <p className="font-medium">
              {filtered ? 'No tickets match these filters.' : 'This queue is empty.'}
            </p>
          </div>
        )}

        {page && page.items.length > 0 && (
          <div aria-busy={loading}>
            <div className="overflow-x-auto rounded border border-slate-200 bg-white">
              <table className="w-full min-w-[46rem] text-left text-sm">
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
                      <td className="p-2">
                        <PriorityChip priority={t.priority} />
                      </td>
                      <th scope="row" className="p-2 font-medium">
                        <Link href={`/technician/tickets/${t.id}`} className="underline">
                          {t.title}
                        </Link>
                      </th>
                      <td className="p-2">
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="p-2">{t.category?.name ?? 'Not set'}</td>
                      <td className="p-2">{t.assignee?.name ?? 'Unassigned'}</td>
                      <td className="p-2" title={`${t.ageMinutes} minutes`}>
                        {formatAge(t.ageMinutes)}
                      </td>
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
      </div>
    </section>
  );
}
