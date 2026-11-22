import type {
  AdminCategoryDto,
  AdminTeamDto,
  AdminTeamMemberDto,
  AdminUserList,
} from '@smartdesk/contracts';
import { ApiError, NetworkError, type ApiClient } from '../auth/client';

export interface CatalogInput {
  name: string;
  description: string | null;
}

const enc = encodeURIComponent;
const json = (body: unknown) => ({ body: JSON.stringify(body) });

/** Typed wrappers for the administrator category and team endpoints. */
export function catalogApi(api: ApiClient) {
  return {
    categories: () => api.request<AdminCategoryDto[]>('/api/admin/categories'),
    createCategory: (input: CatalogInput) =>
      api.request<AdminCategoryDto>('/api/admin/categories', { method: 'POST', ...json(input) }),
    updateCategory: (id: string, input: CatalogInput) =>
      api.request<AdminCategoryDto>(`/api/admin/categories/${enc(id)}`, {
        method: 'PATCH',
        ...json(input),
      }),
    setCategoryActive: (id: string, active: boolean) =>
      api.request<AdminCategoryDto>(
        `/api/admin/categories/${enc(id)}/${active ? 'activate' : 'deactivate'}`,
        { method: 'POST' },
      ),

    teams: () => api.request<AdminTeamDto[]>('/api/admin/teams'),
    createTeam: (input: CatalogInput) =>
      api.request<AdminTeamDto>('/api/admin/teams', { method: 'POST', ...json(input) }),
    updateTeam: (id: string, input: CatalogInput) =>
      api.request<AdminTeamDto>(`/api/admin/teams/${enc(id)}`, {
        method: 'PATCH',
        ...json(input),
      }),
    setTeamActive: (id: string, active: boolean) =>
      api.request<AdminTeamDto>(
        `/api/admin/teams/${enc(id)}/${active ? 'activate' : 'deactivate'}`,
        { method: 'POST' },
      ),
    members: (teamId: string) =>
      api.request<AdminTeamMemberDto[]>(`/api/admin/teams/${enc(teamId)}/members`),
    addMember: (teamId: string, userId: string) =>
      api.request<AdminTeamMemberDto>(`/api/admin/teams/${enc(teamId)}/members`, {
        method: 'POST',
        ...json({ userId }),
      }),
    removeMember: (teamId: string, userId: string) =>
      api.request<null>(`/api/admin/teams/${enc(teamId)}/members/${enc(userId)}`, {
        method: 'DELETE',
      }),
    /** Active technicians, the only accounts that can join a team. */
    technicians: () =>
      api.request<AdminUserList>('/api/admin/users?role=TECHNICIAN&active=true&limit=200'),
  };
}

/** A message safe to show an administrator; server text for 4xx is written for them. */
export function describeCatalogError(err: unknown): string {
  if (err instanceof NetworkError) return 'Unable to reach the server. Try again.';
  if (err instanceof ApiError && err.status < 500) return err.message;
  return 'Something went wrong. Please try again.';
}
