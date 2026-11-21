import type {
  AdminKnowledgeArticleDto,
  AdminKnowledgeArticleSummaryDto,
  ArticlePage,
  CategoryRefDto,
  KnowledgeArticleDto,
  KnowledgeArticleSummaryDto,
  KnowledgeSearchResultDto,
} from '@smartdesk/contracts';
import type { ApiClient } from '../auth/client';

export interface ArticleDraft {
  title: string;
  body: string;
  categoryId: string | null;
}

const enc = encodeURIComponent;

function params(values: Record<string, string | number | boolean | undefined | null>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') out.set(key, String(value));
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

/** Typed wrappers for the knowledge-base endpoints. Every call hits the real API. */
export function knowledgeApi(api: ApiClient) {
  return {
    // --- Readers (published only; the server decides, never the client) ---------------------
    search(opts: { q: string; categoryId?: string; limit?: number; offset?: number }) {
      return api.request<ArticlePage<KnowledgeSearchResultDto>>(
        `/api/knowledge/search${params(opts)}`,
      );
    },
    list(opts: { categoryId?: string; limit?: number; offset?: number } = {}) {
      return api.request<ArticlePage<KnowledgeArticleSummaryDto>>(`/api/knowledge${params(opts)}`);
    },
    categories() {
      return api.request<CategoryRefDto[]>('/api/knowledge/categories');
    },
    get(id: string) {
      return api.request<KnowledgeArticleDto>(`/api/knowledge/${enc(id)}`);
    },

    // --- Administrators ----------------------------------------------------------------------
    adminList(opts: { published?: boolean; categoryId?: string; limit?: number; offset?: number }) {
      return api.request<ArticlePage<AdminKnowledgeArticleSummaryDto>>(
        `/api/admin/knowledge${params(opts)}`,
      );
    },
    adminGet(id: string) {
      return api.request<AdminKnowledgeArticleDto>(`/api/admin/knowledge/${enc(id)}`);
    },
    create(draft: ArticleDraft) {
      return api.request<AdminKnowledgeArticleDto>('/api/admin/knowledge', {
        method: 'POST',
        body: JSON.stringify(draft),
      });
    },
    update(id: string, draft: ArticleDraft) {
      return api.request<AdminKnowledgeArticleDto>(`/api/admin/knowledge/${enc(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
    },
    publish(id: string) {
      return api.request<AdminKnowledgeArticleDto>(`/api/admin/knowledge/${enc(id)}/publish`, {
        method: 'POST',
      });
    },
    unpublish(id: string) {
      return api.request<AdminKnowledgeArticleDto>(`/api/admin/knowledge/${enc(id)}/unpublish`, {
        method: 'POST',
      });
    },
    allCategories() {
      return api.request<CategoryRefDto[]>('/api/categories');
    },
  };
}
