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

export interface MockApi {
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

  return {
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
