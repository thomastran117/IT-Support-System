import type {
  CreateCommentRequest,
  CreateTicketRequest,
  TicketCommentDto,
  TicketDetailDto,
  TicketDto,
  TicketPage,
  TicketPriority,
  TicketStatus,
} from '@smartdesk/contracts';
import { IDEMPOTENCY_KEY_HEADER } from '@smartdesk/contracts';
import type { ApiClient } from '../auth/client';

export interface ListQuery {
  status?: TicketStatus;
  priority?: TicketPriority;
  limit?: number;
  offset?: number;
}

/** Typed wrappers over the shared API client. Every call hits the real API (no sample data). */
export function ticketsApi(api: ApiClient) {
  return {
    /** `idempotencyKey` makes a retried submission resolve to the ticket the first attempt made. */
    create(input: CreateTicketRequest, idempotencyKey: string) {
      return api.request<TicketDto>('/api/tickets', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      });
    },

    list(query: ListQuery = {}) {
      const params = new URLSearchParams();
      if (query.status) params.set('status', query.status);
      if (query.priority) params.set('priority', query.priority);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.offset) params.set('offset', String(query.offset));
      const qs = params.toString();
      return api.request<TicketPage>(`/api/tickets${qs ? `?${qs}` : ''}`);
    },

    get(id: string) {
      return api.request<TicketDetailDto>(`/api/tickets/${encodeURIComponent(id)}`);
    },

    /** Employees can only post public replies, so `isInternal` is never sent. */
    reply(id: string, body: string) {
      const payload: CreateCommentRequest = { body };
      return api.request<TicketCommentDto>(`/api/tickets/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
  };
}

export type TicketsApi = ReturnType<typeof ticketsApi>;
