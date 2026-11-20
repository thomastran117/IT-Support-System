import type { Page, Route } from '@playwright/test';

/**
 * In-browser stand-in for the auth API. The e2e suite must not depend on the backend, so every
 * `/api/auth/*` call is answered here. `session` plays the role of the HttpOnly refresh cookie:
 * it survives reloads (like a cookie) and can be revoked to simulate a disabled user.
 */
export const PASSWORD = 'SmartDesk-Demo-1!';

export const ACCOUNTS = {
  employee: {
    id: 'u-erin',
    email: 'erin@smartdesk.test',
    displayName: 'Erin Employee',
    role: 'EMPLOYEE',
    portal: '/employee',
    heading: 'Employee area',
  },
  technician: {
    id: 'u-tara',
    email: 'tara@smartdesk.test',
    displayName: 'Tara Technician',
    role: 'TECHNICIAN',
    portal: '/technician',
    heading: 'Technician area',
  },
  admin: {
    id: 'u-admin',
    email: 'admin@smartdesk.test',
    displayName: 'Alex Admin',
    role: 'ADMIN',
    portal: '/admin',
    heading: 'Admin area',
  },
} as const;

export type AccountKey = keyof typeof ACCOUNTS;
type Account = (typeof ACCOUNTS)[AccountKey];

interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}
interface AuditRow {
  id: string;
  action: string;
  actor: { id: string; email: string };
  target: { id: string; email: string };
  details: object;
  createdAt: string;
}

export interface MockApi {
  /** Live view of the mocked accounts (what the admin API would return). */
  adminUsers(): readonly AdminUserRow[];
  /** Simulates the server disabling the account / expiring the refresh cookie. */
  revokeSession(): void;
  /** While true every request fails like an unreachable server. */
  setOffline(offline: boolean): void;
  /** Make the next login attempts answer 429. */
  rateLimitLogins(on: boolean): void;
  count(endpoint: 'login' | 'refresh' | 'logout' | 'me'): number;
}

const publicUser = ({ id, email, displayName, role }: Account) => ({
  id,
  email,
  displayName,
  role,
});

export async function installMockApi(page: Page): Promise<MockApi> {
  let session: Account | null = null;
  let offline = false;
  let limited = false;
  let tokenSeq = 0;
  let currentToken = '';
  const counts = { login: 0, refresh: 0, logout: 0, me: 0 };

  const cors = (route: Route) => {
    const origin = route.request().headers()['origin'] ?? '*';
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
  };
  const reply = (route: Route, status: number, data: unknown = null, message = '') =>
    route.fulfill({
      status,
      headers: { ...cors(route), 'content-type': 'application/json' },
      body: JSON.stringify({ message, error: status >= 400 ? 'Error' : null, details: null, data }),
    });
  const issue = (account: Account) => {
    currentToken = `access-${account.id}-${++tokenSeq}`;
    return { accessToken: currentToken, expiresIn: 900, user: publicUser(account) };
  };

  await page.route(/\/api\/auth\/(login|refresh|logout|me)$/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: cors(route) });
    }
    if (offline) return route.abort('failed');
    const endpoint = req.url().split('/').pop() as keyof typeof counts;
    counts[endpoint]++;

    switch (endpoint) {
      case 'login': {
        if (limited) return reply(route, 429, null, 'Too many requests');
        const body = req.postDataJSON() as { email?: string; password?: string };
        const account = Object.values(ACCOUNTS).find((a) => a.email === body.email);
        if (!account || body.password !== PASSWORD) {
          return reply(route, 401, null, 'Invalid email or password');
        }
        session = account;
        return reply(route, 200, issue(account), 'Signed in');
      }
      case 'refresh':
        return session
          ? reply(route, 200, issue(session), 'Session refreshed')
          : reply(route, 401, null, 'Session is invalid or expired');
      case 'logout':
        session = null;
        return reply(route, 200, null, 'Signed out');
      case 'me': {
        const auth = req.headers()['authorization'];
        return session && auth === `Bearer ${currentToken}`
          ? reply(route, 200, publicUser(session), 'Current user')
          : reply(route, 401, null, 'Authentication required');
      }
    }
  });

  // --- Admin API (SD-017): a tiny in-memory model of the server's rules ----------------------
  const users: AdminUserRow[] = [
    ...Object.values(ACCOUNTS).map((a, i) => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      role: a.role as string,
      isActive: true,
      createdAt: `2026-02-0${i + 1}T08:00:00.000Z`,
    })),
    {
      id: 'u-ivan',
      email: 'ivan.inactive@smartdesk.test',
      displayName: 'Ivan Inactive',
      role: 'EMPLOYEE',
      isActive: false,
      createdAt: '2026-02-09T08:00:00.000Z',
    },
  ];
  const auditLog: AuditRow[] = [];
  let userSeq = 0;
  const record = (action: string, target: AdminUserRow, details: object = {}) => {
    auditLog.unshift({
      id: `a-${auditLog.length + 1}`,
      action,
      actor: { id: session?.id ?? '', email: session?.email ?? '' },
      target: { id: target.id, email: target.email },
      details,
      createdAt: new Date().toISOString(),
    });
  };

  await page.route(/\/api\/admin\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(route) });
    if (offline) return route.abort('failed');
    if (session?.role !== 'ADMIN') return reply(route, 403, null, 'Forbidden');
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/admin', '');

    if (req.method() === 'GET' && path === '/users') {
      return reply(route, 200, { items: users, total: users.length });
    }
    if (req.method() === 'GET' && path === '/audit-log') return reply(route, 200, auditLog);
    if (req.method() === 'POST' && path === '/users') {
      const body = req.postDataJSON() as { email: string; displayName: string; role: string };
      const email = body.email.trim().toLowerCase();
      if (users.some((u) => u.email === email)) {
        return reply(route, 409, null, 'A user with this email already exists.');
      }
      const created: AdminUserRow = {
        id: `u-new-${++userSeq}`,
        email,
        displayName: body.displayName,
        role: body.role,
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      users.push(created);
      users.sort((a, b) => a.email.localeCompare(b.email));
      record('USER_CREATED', created, { role: created.role });
      return reply(route, 201, {
        user: created,
        temporaryPassword: `TempPw-${userSeq}-abcdefghij`,
      });
    }

    const match = /^\/users\/([^/]+)\/(role|deactivate|activate|reset-password)$/.exec(path);
    const target = match && users.find((u) => u.id === match[1]);
    if (!match || !target) return reply(route, 404, null, 'User not found');
    if (target.id === session.id && match[2] !== 'activate') {
      return reply(route, 403, null, 'You cannot change your own account.');
    }
    switch (match[2]) {
      case 'role': {
        const { role } = req.postDataJSON() as { role: string };
        record('ROLE_CHANGED', target, { from: target.role, to: role });
        target.role = role;
        return reply(route, 200, target);
      }
      case 'deactivate':
      case 'activate':
        target.isActive = match[2] === 'activate';
        record(match[2] === 'activate' ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', target);
        return reply(route, 200, target);
      default:
        record('PASSWORD_RESET', target);
        return reply(route, 200, {
          user: target,
          temporaryPassword: `Reset-${++userSeq}-abcdefghij`,
        });
    }
  });

  return {
    adminUsers: () => users,
    revokeSession: () => {
      session = null;
    },
    setOffline: (v) => {
      offline = v;
    },
    rateLimitLogins: (v) => {
      limited = v;
    },
    count: (e) => counts[e],
  };
}
