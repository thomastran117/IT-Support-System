import type {
  AnalysisStatusDto,
  ApproveRoutingRequest,
  CategoryRefDto,
  CreateCommentRequest,
  QueuePage,
  RecommendationDto,
  ReviewRecommendationRequest,
  ReviewResultDto,
  TeamMemberRefDto,
  TeamRefDto,
  TicketCommentDto,
  TicketDetailDto,
  TicketDto,
  TicketPriority,
  TicketStatus,
  TransitionRequest,
} from '@smartdesk/contracts';
import type { ApiClient } from '../auth/client';

export interface QueueFilters {
  priority?: TicketPriority[];
  categoryId?: string;
  status?: TicketStatus[];
  mine?: boolean;
  sort?: 'priority' | 'age';
  limit?: number;
  offset?: number;
}

function toParams(filters: QueueFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (filters.priority?.length) params.set('priority', filters.priority.join(','));
  if (filters.categoryId) params.set('categoryId', filters.categoryId);
  if (filters.status?.length) params.set('status', filters.status.join(','));
  if (filters.mine) params.set('mine', 'true');
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));
  return params.toString();
}

const enc = encodeURIComponent;

/** Typed wrappers for the technician endpoints. Every call hits the real API. */
export function technicianApi(api: ApiClient) {
  return {
    /** Unresolved tickets of one team (Q02). */
    teamQueue(teamId: string, filters: QueueFilters = {}) {
      return api.request<QueuePage>(`/api/technician/queue?${toParams(filters, { teamId })}`);
    },
    /** OPEN tickets nobody has routed yet (Q03). */
    unassigned(filters: QueueFilters = {}) {
      return api.request<QueuePage>(`/api/technician/unassigned?${toParams(filters)}`);
    },
    myTeams() {
      return api.request<TeamRefDto[]>('/api/teams?mine=true');
    },
    allTeams() {
      return api.request<TeamRefDto[]>('/api/teams');
    },
    categories() {
      return api.request<CategoryRefDto[]>('/api/categories');
    },
    members(teamId: string) {
      return api.request<TeamMemberRefDto[]>(`/api/teams/${enc(teamId)}/members`);
    },
    ticket(id: string) {
      return api.request<TicketDetailDto>(`/api/tickets/${enc(id)}`);
    },
    /** Current and historical AI recommendations, newest first. Staff only. */
    recommendations(id: string) {
      return api.request<RecommendationDto[]>(`/api/tickets/${enc(id)}/recommendations`);
    },
    /** Status of the newest AI analysis, with the deterministic manual cue. Staff only. */
    analysisStatus(id: string) {
      return api.request<AnalysisStatusDto>(`/api/tickets/${enc(id)}/analysis`);
    },
    /**
     * Ask for a fresh analysis. Always a new job; `requestId` makes a repeated submit idempotent.
     * 409 `ANALYSIS_IN_PROGRESS` / `AI_DISABLED`, 429 `ANALYSIS_RATE_LIMITED`.
     */
    requestAnalysis(id: string, requestId: string) {
      return api.request<AnalysisStatusDto>(`/api/tickets/${enc(id)}/analysis`, {
        method: 'POST',
        body: JSON.stringify({ requestId }),
      });
    },
    reviewRecommendation(id: string, recommendationId: string, body: ReviewRecommendationRequest) {
      return api.request<ReviewResultDto>(
        `/api/tickets/${enc(id)}/recommendations/${enc(recommendationId)}/review`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    approveRouting(id: string, body: ApproveRoutingRequest) {
      return api.request<TicketDto>(`/api/tickets/${enc(id)}/routing`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    transition(id: string, body: TransitionRequest) {
      return api.request<TicketDto>(`/api/tickets/${enc(id)}/transitions`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    comment(id: string, body: CreateCommentRequest) {
      return api.request<TicketCommentDto>(`/api/tickets/${enc(id)}/comments`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}

export type TechnicianApi = ReturnType<typeof technicianApi>;
