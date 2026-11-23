'use client';

import type {
  AdminTeamDto,
  AdminUserList,
  AuthUser,
  CategoryRefDto,
  NamedRef,
  TeamRefDto,
  TicketPriority,
} from '@smartdesk/contracts';
import { useEffect, useId, useState } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import type { ApiClient } from '@/lib/auth/client';
import { PRIORITY_LABEL, STATUS_LABEL, STATUS_ORDER } from '@/lib/tickets/format';
import type { TicketSearchFilter } from '@/lib/tickets/search';
import { inputClass } from './ui';

const statusOptions = STATUS_ORDER.map((id) => ({ id, name: STATUS_LABEL[id] }));
const priorityOptions = (Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((id) => ({
  id,
  name: PRIORITY_LABEL[id],
}));

async function adminAssignees(api: ApiClient, signal: AbortSignal) {
  const options: NamedRef[] = [];
  let offset = 0;
  for (;;) {
    const { items, total } = await api.request<AdminUserList>(
      `/api/admin/users?role=TECHNICIAN&limit=200&offset=${offset}`,
      { signal },
    );
    options.push(...items.map(({ id, displayName }) => ({ id, name: displayName })));
    offset += items.length;
    if (offset >= total || items.length === 0) return options;
  }
}

function FilterSelect({
  label,
  value,
  options,
  empty,
  onChange,
}: {
  label: string;
  value: string;
  options: NamedRef[];
  empty: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label className="app-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{empty}</option>
        {value && !options.some(({ id }) => id === value) && (
          <option value={value}>Selected {label.toLowerCase()}</option>
        )}
        {options.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TicketSearchFilters({
  id,
  user,
  params,
  change,
  active,
  reset,
}: {
  id: string;
  user: AuthUser;
  params: URLSearchParams;
  change: (changes: Partial<Record<TicketSearchFilter, string>>) => void;
  active: boolean;
  reset: () => void;
}) {
  const { api } = useAuth();
  const [categories, setCategories] = useState<NamedRef[]>([]);
  const [teams, setTeams] = useState<NamedRef[]>([]);
  const [assignees, setAssignees] = useState<NamedRef[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    function load<T>(task: Promise<T>, apply: (value: T) => void) {
      void task
        .then((value) => {
          if (!signal.aborted) apply(value);
        })
        .catch(() => {
          if (!signal.aborted) setFailed(true);
        });
    }
    load(api.request<CategoryRefDto[]>('/api/categories', { signal }), setCategories);
    if (user.role === 'ADMIN') {
      load(api.request<AdminTeamDto[]>('/api/admin/teams', { signal }), setTeams);
      load(adminAssignees(api, signal), setAssignees);
    } else if (user.role === 'TECHNICIAN') {
      load(api.request<TeamRefDto[]>('/api/teams?mine=true', { signal }), setTeams);
    }
    return () => controller.abort();
  }, [api, user.role]);

  const select = (key: TicketSearchFilter, label: string, empty: string, options: NamedRef[]) => (
    <FilterSelect
      label={label}
      empty={empty}
      options={options}
      value={params.get(key) ?? ''}
      onChange={(value) => change({ [key]: value })}
    />
  );
  return (
    <fieldset id={id} className="min-w-0 space-y-3 border-t border-slate-200 pt-3">
      <legend className="sr-only">Search filters</legend>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {select('status', 'Status', 'All statuses', statusOptions)}
        {select('priority', 'Priority', 'All priorities', priorityOptions)}
        {select('categoryId', 'Category', 'All categories', categories)}
        {user.role !== 'EMPLOYEE' && select('teamId', 'Team', 'All visible teams', teams)}
        {user.role !== 'EMPLOYEE' &&
          select(
            'assigneeId',
            'Assignee',
            'All visible assignees',
            user.role === 'ADMIN' ? assignees : [{ id: user.id, name: 'Assigned to me' }],
          )}
        <div className="min-w-0">
          <label htmlFor={`${id}-from`} className="app-label">
            Created from (UTC)
          </label>
          <input
            id={`${id}-from`}
            type="date"
            className={inputClass}
            value={params.get('createdFrom') ?? ''}
            onChange={(e) => change({ createdFrom: e.target.value })}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-through`} className="app-label">
            Created through (UTC)
          </label>
          <input
            id={`${id}-through`}
            type="date"
            className={inputClass}
            value={params.get('createdTo') ?? ''}
            onChange={(e) => change({ createdTo: e.target.value })}
          />
        </div>
      </div>
      {failed && (
        <p role="status" className="text-sm text-slate-600">
          Some filter options could not be loaded.
        </p>
      )}
      {active && (
        <button type="button" className="app-button-quiet" onClick={reset}>
          Reset filters
        </button>
      )}
    </fieldset>
  );
}
