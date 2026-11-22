import type {
  AiEvaluationReportDto,
  CategoryRefDto,
  ClassificationLabelDto,
  ClassificationLabelPage,
  ReportSummaryDto,
} from '@smartdesk/contracts';
import type { ApiClient } from '../auth/client';

/** Typed wrapper for the administrator report endpoint. Every call hits the real API. */
export function reportsApi(api: ApiClient) {
  return {
    /** `start` inclusive and `end` exclusive, both ISO instants (UTC). */
    summary(start: string, end: string) {
      const q = new URLSearchParams({ start, end });
      return api.request<ReportSummaryDto>(`/api/admin/reports/summary?${q.toString()}`);
    },
    aiEvaluation(start: string, end: string) {
      const q = new URLSearchParams({ start, end });
      return api.request<AiEvaluationReportDto>(`/api/admin/reports/ai-evaluation?${q.toString()}`);
    },
    labels(limit = 50, offset = 0) {
      return api.request<ClassificationLabelPage>(
        `/api/admin/classification-labels?limit=${limit}&offset=${offset}`,
      );
    },
    /** Creates or replaces the independent label; the server records who and when. */
    saveLabel(ticketId: string, referenceCategoryId: string) {
      return api.request<ClassificationLabelDto>(
        `/api/admin/tickets/${encodeURIComponent(ticketId)}/classification-label`,
        { method: 'PUT', body: JSON.stringify({ referenceCategoryId }) },
      );
    },
    categories() {
      return api.request<CategoryRefDto[]>('/api/categories');
    },
  };
}
