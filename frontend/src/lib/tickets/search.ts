import { ticketSearchQuerySchema, type TicketSearchQuery } from '@smartdesk/contracts';

export const ticketSearchFilters = [
  'status',
  'priority',
  'categoryId',
  'teamId',
  'assigneeId',
  'createdFrom',
  'createdTo',
] as const;
export type TicketSearchFilter = (typeof ticketSearchFilters)[number];
const searchKeys = ['q', ...ticketSearchFilters, 'cursor'] as const;

/** Keep only known search state when linking from a result to its detail and back. */
export function ticketSearchHref(path: string, params: Pick<URLSearchParams, 'get'>) {
  const search = new URLSearchParams();
  if (params.get('q')?.trim()) {
    for (const key of searchKeys) {
      const value = params.get(key);
      if (value) search.set(key, value);
    }
  }
  return search.size ? `${path}?${search}` : path;
}

function utcDay(value: string | null, end = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value ?? undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) return value;
  if (end) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export function ticketSearchRequest(params: URLSearchParams): TicketSearchQuery | null {
  const query = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? undefined,
    priority: params.get('priority') ?? undefined,
    categoryId: params.get('categoryId') ?? undefined,
    teamId: params.get('teamId') ?? undefined,
    assigneeId: params.get('assigneeId') ?? undefined,
    createdFrom: utcDay(params.get('createdFrom')),
    createdTo: utcDay(params.get('createdTo'), true),
    cursor: params.get('cursor') ?? undefined,
    limit: '10',
  };
  // Send ISO timestamps in the URL; the shared validator also checks that the range is ordered.
  const parsed = ticketSearchQuerySchema.safeParse(query);
  if (!parsed.success) return null;
  return { ...query, q: parsed.data.q, status: parsed.data.status, priority: parsed.data.priority };
}
