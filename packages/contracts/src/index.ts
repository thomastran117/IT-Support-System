// Browser-safe shared contracts. Do not import server-only code (node:*, pg, fastify) here.

/** Consistent JSON envelope returned by every API response. */
export interface ApiEnvelope<T = unknown> {
  message: string;
  error: string | null;
  details: unknown;
  data: T | null;
}

export type HealthStatus = 'ok' | 'unavailable';

export interface LiveHealth {
  status: 'ok';
}

export interface ReadyHealth {
  status: HealthStatus;
  checks: { database: HealthStatus };
}

export const API_PREFIX = '/api';

// --- Authentication (SD-014) ---------------------------------------------------------------

export type Role = 'EMPLOYEE' | 'TECHNICIAN' | 'ADMIN';

/** Public profile of the signed-in user. Never contains credentials. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** Returned by login and refresh. The refresh token travels only in an HttpOnly cookie. */
export interface AuthSession {
  accessToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  user: AuthUser;
}

// --- Administration (SD-017) ---------------------------------------------------------------

/** An account as an administrator sees it. Never contains credentials or token state. */
export interface AdminUser extends AuthUser {
  isActive: boolean;
  createdAt: string;
}

export interface CreateUserRequest {
  email: string;
  displayName: string;
  role: Role;
}

/** Create and password-reset responses. The temporary password is shown exactly once. */
export interface UserWithTemporaryPassword {
  user: AdminUser;
  temporaryPassword: string;
}

export interface AdminUserList {
  items: AdminUser[];
  total: number;
}

export type AdminAuditAction =
  'USER_CREATED' | 'USER_ACTIVATED' | 'USER_DEACTIVATED' | 'ROLE_CHANGED' | 'PASSWORD_RESET';

export interface AdminAuditEntry {
  id: string;
  action: AdminAuditAction;
  actor: { id: string; email: string };
  target: { id: string; email: string };
  details: Record<string, unknown>;
  createdAt: string;
}
