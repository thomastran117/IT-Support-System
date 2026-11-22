import type { ReportSummaryDto } from '@smartdesk/contracts';
import type { ApiClient } from '../auth/client';

/** Typed wrapper for the administrator report endpoint. Every call hits the real API. */
export function reportsApi(api: ApiClient) {
  return {
    /** `start` inclusive and `end` exclusive, both ISO instants (UTC). */
    summary(start: string, end: string) {
      const q = new URLSearchParams({ start, end });
      return api.request<ReportSummaryDto>(`/api/admin/reports/summary?${q.toString()}`);
    },
  };
}
