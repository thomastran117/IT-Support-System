import type { NotificationPage, NotificationReadResult } from '@smartdesk/contracts';
import type { ApiClient } from '../auth/client';

export interface NotificationQuery {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** Typed wrappers over the shared API client. Every call hits the real API (no sample data). */
export function notificationsApi(api: ApiClient) {
  return {
    list(query: NotificationQuery = {}) {
      const params = new URLSearchParams();
      if (query.unreadOnly) params.set('unreadOnly', 'true');
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.offset) params.set('offset', String(query.offset));
      const qs = params.toString();
      return api.request<NotificationPage>(`/api/notifications${qs ? `?${qs}` : ''}`);
    },

    markRead(id: string) {
      return api.request<NotificationReadResult>(
        `/api/notifications/${encodeURIComponent(id)}/read`,
        { method: 'PATCH' },
      );
    },

    markAllRead() {
      return api.request<NotificationReadResult>('/api/notifications/read-all', {
        method: 'POST',
      });
    },
  };
}
