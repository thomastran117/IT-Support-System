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
    heading: 'My tickets',
  },
  technician: {
    id: 'u-tara',
    email: 'tara@smartdesk.test',
    displayName: 'Tara Technician',
    role: 'TECHNICIAN',
    portal: '/technician',
    heading: 'Technician dashboard',
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

export type TicketStatus = 'OPEN' | 'TRIAGED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

interface MockComment {
  id: string;
  body: string;
  isInternal: boolean;
  author: { id: string; name: string };
  createdAt: string;
}
interface MockEvent {
  id: string;
  type: string;
  occurredAt: string;
  details: Record<string, unknown>;
}
export interface MockTicket {
  id: string;
  requesterId: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: string;
  category: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionSummary: string | null;
  version: number;
  comments: MockComment[];
  events: MockEvent[];
  recommendations: MockRecommendation[];
  analysis: MockAnalysis;
}

export interface MockAnalysis {
  state: 'NONE' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  requestId: string | null;
  attempts: number;
  maxAttempts: number;
  retryAt: string | null;
  failure: { reason: string; message: string } | null;
  updatedAt: string | null;
}

export interface MockRecommendation {
  id: string;
  createdAt: string;
  modelVersion: string;
  confidence: number | null;
  suggestion: string | null;
  proposed: {
    category: { id: string; name: string; isActive: boolean } | null;
    team: { id: string; name: string; isActive: boolean } | null;
    priority: string | null;
  };
  review: {
    status: 'PENDING' | 'ACCEPTED' | 'OVERRIDDEN' | 'REJECTED';
    reviewer: { id: string; name: string } | null;
    reviewedAt: string | null;
    notes: string | null;
  };
  articles: { id: string; title: string }[];
}

export interface MockArticle {
  id: string;
  title: string;
  body: string;
  categoryId: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MockNotification {
  id: string;
  recipientId: string;
  type: string;
  message: string;
  ticketId: string;
  ticketTitle: string;
  readAt: string | null;
  createdAt: string;
}

export interface MockApi {
  /** The server-side notifications (all recipients), oldest first. */
  notifications(): readonly MockNotification[];
  /** The server-side knowledge articles (published and draft). */
  knowledge: {
    articles(): readonly MockArticle[];
    /** Add an article directly on the "server". Returns it. */
    seed(a: {
      title: string;
      body: string;
      categoryId?: string | null;
      isPublished?: boolean;
    }): MockArticle;
  };
  /** The server-side tickets (all requesters). */
  tickets(): readonly MockTicket[];
  /** Create `n` tickets owned by the employee, newest last. Returns them. */
  seedTickets(n: number, requesterId?: string): MockTicket[];
  /** A ticket belonging to somebody else, to prove it can never be opened. */
  seedForeignTicket(): MockTicket;
  /** Plays a technician: changes the ticket on the server, as the real backend would. */
  technician: {
    update(
      id: string,
      change: {
        status?: TicketStatus;
        priority?: string;
        category?: string;
        team?: string;
        resolutionSummary?: string;
      },
    ): void;
    reply(id: string, body: string, isInternal?: boolean): void;
    /** The AI analysis finished: adds a PENDING recommendation (newest first in the API). */
    suggest(
      id: string,
      proposal: { category?: string; team?: string; priority?: string; suggestion?: string },
    ): MockRecommendation;
    /** Set the AI analysis job state, as the worker would. */
    setAnalysis(id: string, change: Partial<MockAnalysis>): void;
    /** The worker finished: marks the analysis COMPLETED and adds the recommendation. */
    finishAnalysis(
      id: string,
      proposal: { category?: string; team?: string; priority?: string; suggestion?: string },
    ): MockRecommendation;
    /** Mark a category or team inactive so proposals that point at it become stale. */
    deactivate(kind: 'category' | 'team', name: string): void;
  };
  /** The next call to this endpoint fails with the HTTP status, or `'network'` to drop the request. */
  /** Pretend no AI provider is configured (analysis disabled). */
  setAiEnabled(enabled: boolean): void;
  /** Make POST analysis answer 429 and `canRetry` false (hourly limit reached). */
  limitAnalysis(on: boolean): void;
  /** The request ids of every POST /analysis that reached the server, in order. */
  analysisRequests(): readonly (string | undefined)[];
  /** Every notifications request fails with this status (or `'network'`) until set to `null`. */
  setNotificationsDown(status: number | 'network' | null): void;
  failNext(
    endpoint:
      | 'create'
      | 'reply'
      | 'list'
      | 'detail'
      | 'queue'
      | 'recs'
      | 'analysis'
      | 'notifications'
      | 'report',
    status: number | 'network',
  ): void;
  /** Number of POST /api/tickets requests that reached the server (including idempotent replays). */
  createRequests(): number;
  /** The Idempotency-Key header of each create request, in order. */
  createKeys(): readonly (string | undefined)[];
  /** Live view of the mocked accounts (what the admin API would return). */
  adminUsers(): readonly AdminUserRow[];
  /** The `start`/`end` query of every report request that reached the server, in order. */
  reportRequests(): readonly { start: string; end: string }[];
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

// --- Report fixtures (SD-045): a few tickets the mock aggregates for any requested window ------
interface ReportTicket {
  created: string;
  category: string;
  routedAfterMin: number | null;
  respondedAfterMin: number | null;
  resolvedAt: string | null;
}
export const REPORT_TICKETS: ReportTicket[] = [
  {
    created: '2026-03-02T09:00:00Z',
    category: 'Network/VPN',
    routedAfterMin: 10,
    respondedAfterMin: 35,
    resolvedAt: null,
  },
  {
    created: '2026-03-02T14:00:00Z',
    category: 'Hardware',
    routedAfterMin: 20,
    respondedAfterMin: null,
    resolvedAt: null,
  },
  {
    created: '2026-03-04T08:00:00Z',
    category: 'Software',
    routedAfterMin: 30,
    respondedAfterMin: 90,
    resolvedAt: '2026-03-04T20:00:00Z',
  },
  {
    created: '2026-03-09T13:00:00Z',
    category: 'Hardware',
    routedAfterMin: null,
    respondedAfterMin: null,
    resolvedAt: null,
  },
];

function summarize(start: string, end: string) {
  const s = Date.parse(start);
  const e = Date.parse(end);
  const inWin = (iso: string) => Date.parse(iso) >= s && Date.parse(iso) < e;
  const cohort = REPORT_TICKETS.filter((t) => inWin(t.created));
  const mean = (xs: number[]) =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
  const routed = cohort.flatMap((t) => (t.routedAfterMin === null ? [] : [t.routedAfterMin]));
  const responded = cohort.flatMap((t) =>
    t.respondedAfterMin === null ? [] : [t.respondedAfterMin],
  );
  const resolved = REPORT_TICKETS.filter((t) => t.resolvedAt && inWin(t.resolvedAt));
  const counts = new Map<string, number>();
  for (const t of cohort) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  const dailyIntake: { date: string; submittedTickets: number }[] = [];
  for (let d = Math.floor(s / 86_400_000) * 86_400_000; d < e; d += 86_400_000) {
    const date = new Date(d).toISOString().slice(0, 10);
    dailyIntake.push({
      date,
      submittedTickets: cohort.filter((t) => t.created.slice(0, 10) === date).length,
    });
  }
  return {
    window: { start: new Date(s).toISOString(), end: new Date(e).toISOString() },
    submitted: cohort.length,
    routing: { routed: routed.length, avgMinutes: mean(routed) },
    firstResponse: { responded: responded.length, avgMinutes: mean(responded) },
    resolution: {
      resolvedTickets: resolved.length,
      avgHours: mean(
        resolved.map((t) => (Date.parse(t.resolvedAt!) - Date.parse(t.created)) / 3_600_000),
      ),
    },
    aiAccuracy: { labelledTickets: 0, withRecommendation: 0, correct: 0, accuracyPct: null },
    aiAcceptance: { reviewed: 0, accepted: 0, acceptancePct: null },
    categories: [...counts].map(([category, ticketCount]) => ({ category, ticketCount })),
    dailyIntake,
    units: { routing: 'minutes', firstResponse: 'minutes', resolution: 'hours', rates: 'percent' },
  };
}

export async function installMockApi(page: Page): Promise<MockApi> {
  let session: Account | null = null;
  let offline = false;
  let limited = false;
  let tokenSeq = 0;
  let currentToken = '';
  const counts = { login: 0, refresh: 0, logout: 0, me: 0 };
  const reportLog: { start: string; end: string }[] = [];

  const cors = (route: Route) => {
    const origin = route.request().headers()['origin'] ?? '*';
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    };
  };
  const reply = (
    route: Route,
    status: number,
    data: unknown = null,
    message = '',
    details: unknown = null,
  ) =>
    route.fulfill({
      status,
      headers: { ...cors(route), 'content-type': 'application/json' },
      body: JSON.stringify({ message, error: status >= 400 ? 'Error' : null, details, data }),
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
    if (req.method() === 'GET' && path === '/reports/summary') {
      const start = url.searchParams.get('start') ?? '';
      const end = url.searchParams.get('end') ?? '';
      reportLog.push({ start, end });
      if (failures.get('report')) {
        const status = failures.get('report')!;
        failures.delete('report');
        if (status === 'network') return route.abort('failed');
        return reply(route, status, null, 'Report failed');
      }
      return reply(route, 200, summarize(start, end), 'Report summary');
    }
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

  // --- Tickets API (SD-018 to SD-022): the server's rules, in memory ---------------------------
  const tickets: MockTicket[] = [];
  const idempotent = new Map<string, MockTicket>();
  const createKeys: (string | undefined)[] = [];
  const failures = new Map<string, number | 'network'>();
  let aiEnabled = true;
  let analysisLimited = false;
  const analysisRequestIds: (string | undefined)[] = [];
  let createRequests = 0;
  let ticketSeq = 0;
  let commentSeq = 0;
  let clockMs = Date.parse('2026-03-01T09:00:00.000Z');
  const tick = () => new Date((clockMs += 60_000)).toISOString();
  const uuid = (kind: number, n: number) =>
    `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const newTicket = (requesterId: string, title: string, description: string): MockTicket => {
    const at = tick();
    const t: MockTicket = {
      id: uuid(4, ++ticketSeq),
      requesterId,
      title,
      description,
      status: 'OPEN',
      priority: 'UNSET',
      category: null,
      team: null,
      assignee: null,
      createdAt: at,
      updatedAt: at,
      resolvedAt: null,
      resolutionSummary: null,
      version: 1,
      comments: [],
      recommendations: [],
      analysis: {
        state: 'NONE',
        requestId: null,
        attempts: 0,
        maxAttempts: 0,
        retryAt: null,
        failure: null,
        updatedAt: null,
      },
      events: [{ id: uuid(6, ++ticketSeq + 1000), type: 'CREATED', occurredAt: at, details: {} }],
    };
    tickets.push(t);
    return t;
  };
  const addEvent = (t: MockTicket, type: string, details: Record<string, unknown> = {}) => {
    const at = tick();
    t.events.push({ id: uuid(6, ++ticketSeq + 1000), type, occurredAt: at, details });
    t.updatedAt = at;
    t.version++;
  };

  // --- Notifications (SD-040/041): the same policy as the backend, in memory ------------------
  const notifications: MockNotification[] = [];
  let notificationSeq = 0;
  let notificationsDown: number | 'network' | null = null;
  const NOTICE_TEXT: Record<string, string> = {
    TICKET_ASSIGNED: 'Your ticket was assigned to a support team.',
    TICKET_STATUS_CHANGED: 'The status of your ticket changed.',
    TICKET_RESOLVED: 'Your ticket was resolved.',
    TICKET_REOPENED: 'Your ticket was reopened.',
    TECHNICIAN_REPLY: 'A technician replied to your ticket.',
  };
  /** A technician acted on the ticket, so its requester gets a notification of `type`. */
  const notify = (t: MockTicket, type: string) => {
    notifications.push({
      id: uuid(8, ++notificationSeq),
      recipientId: t.requesterId,
      type,
      message: NOTICE_TEXT[type]!,
      ticketId: t.id,
      ticketTitle: t.title,
      readAt: null,
      createdAt: tick(),
    });
  };

  const REQUESTER_EVENTS = new Set([
    'CREATED',
    'STATUS_CHANGED',
    'RESOLVED',
    'REOPENED',
    'TEAM_ASSIGNED',
    'TEAM_REASSIGNED',
    'CATEGORY_UPDATED',
    'PRIORITY_UPDATED',
  ]);
  const summary = (t: MockTicket) => ({
    id: t.id,
    trackingId: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    category: t.category,
    team: t.team,
    assignee: t.assignee,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
    firstResponseAt: null,
    version: t.version,
  });
  /** What the real API returns to the requester: public comments and a reduced timeline only. */
  const detail = (t: MockTicket) => ({
    ...summary(t),
    description: t.description,
    resolutionSummary: t.resolutionSummary,
    requester: { id: t.requesterId, name: 'Requester' },
    comments: t.comments.filter((c) => !c.isInternal),
    timeline: t.events
      .filter((e) => REQUESTER_EVENTS.has(e.type))
      .map((e) => ({
        id: e.id,
        type: e.type,
        occurredAt: e.occurredAt,
        actor: null,
        details:
          e.type === 'STATUS_CHANGED' || e.type === 'PRIORITY_UPDATED'
            ? { from: e.details.from, to: e.details.to }
            : null,
      })),
  });

  // --- Staff reference data and queues (SD-024, SD-025) --------------------------------------
  const TEAMS = [
    { id: 't-net', name: 'Network & Access', description: null },
    { id: 't-hw', name: 'Hardware & Devices', description: null },
  ];
  const CATEGORIES = [
    { id: 'c0000000-0000-4000-8000-000000000001', name: 'Hardware', description: null },
    { id: 'c0000000-0000-4000-8000-000000000002', name: 'Software', description: null },
    { id: 'c0000000-0000-4000-8000-000000000003', name: 'Network/VPN', description: null },
  ];
  const MEMBERS: Record<string, { id: string; displayName: string }[]> = {
    't-net': [
      { id: 'u-tara', displayName: 'Tara Technician' },
      { id: 'u-tom', displayName: 'Tom Technician' },
    ],
    't-hw': [
      { id: 'u-tom', displayName: 'Tom Technician' },
      { id: 'u-hana', displayName: 'Hana Technician' },
    ],
  };
  let recSeq = 0;
  /** Categories and teams switched off with `technician.deactivate`. */
  const inactive = new Set<string>();
  /** Tara belongs to Network & Access only. */
  const TARA_TEAMS = ['t-net'];
  const RANK: Record<string, number> = { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, UNSET: 5 };
  const inScope = (t: MockTicket) => t.team === null || TARA_TEAMS.includes(t.team.id);

  const queueItem = (t: MockTicket) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    category: t.category,
    assignee: t.assignee,
    createdAt: t.createdAt,
    ageMinutes: Math.max(0, Math.round((clockMs - Date.parse(t.createdAt)) / 60_000)),
    version: t.version,
  });

  await page.route(/\/api\/(technician|teams|categories)/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(route) });
    if (offline) return route.abort('failed');
    const auth = req.headers()['authorization'];
    if (!session || auth !== `Bearer ${currentToken}`) {
      return reply(route, 401, null, 'Authentication required');
    }
    if (session.role === 'EMPLOYEE') return reply(route, 403, null, 'Forbidden');
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/', '');
    const q = url.searchParams;

    if (path === 'categories') return reply(route, 200, CATEGORIES);
    if (path === 'teams') {
      const mine = q.get('mine') === 'true' && session.role === 'TECHNICIAN';
      return reply(route, 200, mine ? TEAMS.filter((t) => TARA_TEAMS.includes(t.id)) : TEAMS);
    }
    const members = /^teams\/([^/]+)\/members$/.exec(path);
    if (members) {
      return MEMBERS[members[1]!]
        ? reply(route, 200, MEMBERS[members[1]!])
        : reply(route, 404, null, 'Team not found');
    }
    if (path !== 'technician/queue' && path !== 'technician/unassigned') {
      return reply(route, 404, null, 'Not found');
    }
    const failure = failures.get('queue');
    if (failure !== undefined) {
      failures.delete('queue');
      return failure === 'network'
        ? route.abort('failed')
        : reply(route, failure, null, 'Server error');
    }
    const unassigned = path === 'technician/unassigned';
    const teamId = q.get('teamId');
    if (!unassigned && (!teamId || !TARA_TEAMS.includes(teamId))) {
      return reply(route, 403, null, 'You are not a member of this team');
    }
    const priorities = q.get('priority')?.split(',');
    const category = q.get('categoryId');
    const limit = Number(q.get('limit') ?? 20);
    const offset = Number(q.get('offset') ?? 0);
    const rows = tickets
      .filter((t) =>
        unassigned
          ? t.team === null && t.status === 'OPEN'
          : t.team?.id === teamId && ['OPEN', 'TRIAGED', 'IN_PROGRESS'].includes(t.status),
      )
      .filter((t) => q.get('mine') !== 'true' || t.assignee?.id === session!.id)
      .filter((t) => !priorities || priorities.includes(t.priority))
      .filter((t) => !category || t.category?.id === category)
      .sort(
        (a, b) =>
          (unassigned ? 0 : RANK[a.priority]! - RANK[b.priority]!) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    const items = rows.slice(offset, offset + limit).map(queueItem);
    const next = offset + items.length;
    return reply(route, 200, {
      items,
      total: rows.length,
      limit,
      offset,
      nextOffset: next < rows.length ? next : null,
    });
  });

  await page.route(/\/api\/tickets/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...cors(route),
          'access-control-allow-headers': 'authorization, content-type, idempotency-key',
        },
      });
    }
    if (offline) return route.abort('failed');
    const auth = req.headers()['authorization'];
    if (!session || auth !== `Bearer ${currentToken}`) {
      return reply(route, 401, null, 'Authentication required');
    }
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/tickets', '');
    const method = req.method();

    const kind =
      method === 'POST' && path === ''
        ? 'create'
        : method === 'POST' && path.endsWith('/comments')
          ? 'reply'
          : method === 'GET' && path === ''
            ? 'list'
            : 'detail';
    if (kind === 'create') {
      createRequests++;
      createKeys.push(req.headers()['idempotency-key']);
    }
    const failure = failures.get(kind);
    if (failure !== undefined) {
      failures.delete(kind);
      return failure === 'network'
        ? route.abort('failed')
        : reply(route, failure, null, 'Server error');
    }

    if (method === 'POST' && path === '') {
      const body = req.postDataJSON() as { title?: unknown; description?: unknown };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (!title || title.length > 150 || !description || description.length > 5000) {
        return reply(route, 400, null, 'Validation failed');
      }
      const key = req.headers()['idempotency-key'];
      const previous = key ? idempotent.get(`${session.id}:${key}`) : undefined;
      if (previous) return reply(route, 200, summary(previous), 'Ticket already submitted');
      const created = newTicket(session.id, title, description);
      if (key) idempotent.set(`${session.id}:${key}`, created);
      return reply(
        route,
        201,
        { ...summary(created), description, requesterId: session.id },
        'Ticket created',
      );
    }

    if (method === 'GET' && path === '') {
      const status = url.searchParams.get('status');
      const priority = url.searchParams.get('priority');
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const mine = tickets
        .filter((t) => t.requesterId === session!.id)
        .filter((t) => !status || t.status === status)
        .filter((t) => !priority || t.priority === priority)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const items = mine.slice(offset, offset + limit).map(summary);
      const next = offset + items.length;
      return reply(route, 200, {
        items,
        total: mine.length,
        limit,
        offset,
        nextOffset: next < mine.length ? next : null,
      });
    }

    if (session.role === 'TECHNICIAN') {
      const m =
        /^\/([^/]+)(?:\/(comments|routing|transitions|recommendations(?:\/[^/]+\/review)?|analysis))?$/.exec(
          path,
        );
      const t = m && tickets.find((x) => x.id === m[1]);
      if (!m || !t || !inScope(t)) return reply(route, 404, null, 'Ticket not found');
      const sub = m[2];
      const actor = { id: session.id, name: session.displayName };
      const conflict = () =>
        reply(route, 409, null, 'Ticket was changed by someone else. Reload it and try again.', {
          code: 'VERSION_CONFLICT',
          currentVersion: t.version,
        });
      const staffDetail = () => ({
        ...summary(t),
        description: t.description,
        resolutionSummary: t.resolutionSummary,
        requester: { id: t.requesterId, name: 'Erin Employee' },
        comments: t.comments,
        timeline: t.events.map((e) => ({
          id: e.id,
          type: e.type,
          occurredAt: e.occurredAt,
          actor: e.type === 'CREATED' ? { id: t.requesterId, name: 'Erin Employee' } : actor,
          details: e.details,
        })),
      });
      const dto = () => ({
        id: t.id,
        trackingId: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        categoryId: t.category?.id ?? null,
        teamId: t.team?.id ?? null,
        assigneeId: t.assignee?.id ?? null,
        requesterId: t.requesterId,
        resolutionSummary: t.resolutionSummary,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        resolvedAt: t.resolvedAt,
        firstResponseAt: null,
        version: t.version,
      });

      if (sub === 'analysis') {
        const inFlight = t.analysis.state === 'QUEUED' || t.analysis.state === 'RUNNING';
        const status = () => ({
          enabled: aiEnabled,
          ...t.analysis,
          canRetry: aiEnabled && !inFlight && !analysisLimited,
          manualCue: /ransomware|phishing|outage/i.test(`${t.title} ${t.description}`)
            ? { highRisk: true, reasons: ['Possible security incident'] }
            : { highRisk: false, reasons: [] },
        });
        const failure = failures.get('analysis');
        if (failure !== undefined) {
          failures.delete('analysis');
          return failure === 'network'
            ? route.abort('failed')
            : reply(route, failure, null, 'Server error');
        }
        if (method === 'GET') return reply(route, 200, status());
        const b = (req.postDataJSON() ?? {}) as { requestId?: string };
        analysisRequestIds.push(b.requestId);
        if (!aiEnabled) {
          return reply(route, 409, null, 'AI analysis is not enabled', { code: 'AI_DISABLED' });
        }
        if (b.requestId && b.requestId === t.analysis.requestId) {
          return reply(route, 200, status());
        }
        if (inFlight) {
          return reply(route, 409, null, 'An analysis is already in progress for this ticket', {
            code: 'ANALYSIS_IN_PROGRESS',
          });
        }
        if (analysisLimited) {
          return reply(route, 429, null, 'Too many analysis requests for this ticket', {
            code: 'ANALYSIS_RATE_LIMITED',
          });
        }
        t.analysis = {
          state: 'QUEUED',
          requestId: b.requestId ?? null,
          attempts: 0,
          maxAttempts: 3,
          retryAt: null,
          failure: null,
          updatedAt: tick(),
        };
        return reply(route, 202, status());
      }

      if (method === 'GET' && sub === 'recommendations') {
        const failure = failures.get('recs');
        if (failure !== undefined) {
          failures.delete('recs');
          return failure === 'network'
            ? route.abort('failed')
            : reply(route, failure, null, 'Server error');
        }
        return reply(route, 200, t.recommendations);
      }

      if (method === 'POST' && sub?.startsWith('recommendations/')) {
        const recId = sub.split('/')[1];
        const rec = t.recommendations.find((r) => r.id === recId);
        if (!rec) return reply(route, 404, null, 'Recommendation not found');
        const b = req.postDataJSON() as {
          decision: 'ACCEPTED' | 'OVERRIDDEN' | 'REJECTED';
          expectedVersion: number;
          override?: { categoryId?: string; priority?: string; teamId?: string };
          notes?: string;
        };
        if (b.expectedVersion !== t.version) return conflict();
        const v0 = t.version;
        if (rec.review.status !== 'PENDING') {
          return reply(
            route,
            409,
            null,
            'Recommendation was changed by someone else. Reload it and try again.',
            { code: 'STALE_WRITE' },
          );
        }
        let category = rec.proposed.category && { ...rec.proposed.category };
        let team = rec.proposed.team && { ...rec.proposed.team };
        let priority = rec.proposed.priority;
        if (b.decision === 'OVERRIDDEN') {
          if (b.override?.categoryId) {
            const c = CATEGORIES.find((x) => x.id === b.override!.categoryId);
            category = c ? { id: c.id, name: c.name, isActive: !inactive.has(c.id) } : null;
          }
          if (b.override?.teamId) {
            const x = TEAMS.find((y) => y.id === b.override!.teamId);
            team = x ? { id: x.id, name: x.name, isActive: !inactive.has(x.id) } : null;
          }
          if (b.override?.priority) priority = b.override.priority;
        }
        if (b.decision !== 'REJECTED') {
          if (!category?.isActive || !team?.isActive) {
            return reply(route, 422, null, 'Category or team is unknown or inactive');
          }
          if (t.category?.id !== category.id) {
            addEvent(t, 'CATEGORY_UPDATED', { to: category.id });
          }
          if (priority && t.priority !== priority) {
            addEvent(t, 'PRIORITY_UPDATED', { from: t.priority, to: priority });
          }
          if (t.team?.id !== team.id) {
            addEvent(t, t.team ? 'TEAM_REASSIGNED' : 'TEAM_ASSIGNED', { to: team.id });
          }
          t.category = { id: category.id, name: category.name };
          t.team = { id: team.id, name: team.name };
          if (priority) t.priority = priority;
          if (t.status === 'OPEN') {
            addEvent(t, 'STATUS_CHANGED', { from: 'OPEN', to: 'TRIAGED' });
            t.status = 'TRIAGED';
          }
        }
        addEvent(t, 'AI_REVIEWED', { recommendationId: rec.id, decision: b.decision });
        // One bump when the approved values were written; a rejection changes nothing on the ticket.
        t.version = b.decision === 'REJECTED' ? v0 : v0 + 1;
        rec.review = {
          status: b.decision,
          reviewer: actor,
          reviewedAt: tick(),
          notes: b.notes ?? null,
        };
        return reply(
          route,
          200,
          { ticket: dto(), recommendationId: rec.id, decision: b.decision },
          'Recommendation reviewed',
        );
      }

      if (method === 'GET' && !sub) return reply(route, 200, staffDetail());

      if (method === 'POST' && sub === 'comments') {
        const body = req.postDataJSON() as { body?: unknown; isInternal?: unknown };
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        if (!text || text.length > 5000) return reply(route, 400, null, 'Validation failed');
        const comment: MockComment = {
          id: uuid(5, ++commentSeq),
          body: text,
          isInternal: body.isInternal === true,
          author: actor,
          createdAt: tick(),
        };
        t.comments.push(comment);
        addEvent(t, 'COMMENT_ADDED', { isInternal: comment.isInternal });
        return reply(route, 201, comment, 'Comment added');
      }

      if (method === 'POST' && sub === 'routing') {
        const b = req.postDataJSON() as {
          categoryId: string;
          priority: string;
          teamId: string;
          assigneeId?: string | null;
          expectedVersion: number;
        };
        if (b.expectedVersion !== t.version) return conflict();
        const category = CATEGORIES.find((c) => c.id === b.categoryId);
        const team = TEAMS.find((x) => x.id === b.teamId);
        if (
          !category ||
          !team ||
          inactive.has(category.id) ||
          inactive.has(team.id) ||
          !(b.priority in RANK) ||
          b.priority === 'UNSET'
        ) {
          return reply(route, 422, null, 'Category or team is unknown or inactive');
        }
        const assignee = b.assigneeId
          ? MEMBERS[team.id]!.find((x) => x.id === b.assigneeId)
          : undefined;
        if (b.assigneeId && !assignee) {
          return reply(
            route,
            422,
            null,
            'Assignee must be an active technician in the assigned team',
          );
        }
        const before = t.version;
        if (t.category?.id !== category.id) addEvent(t, 'CATEGORY_UPDATED', { to: category.id });
        if (t.priority !== b.priority) {
          addEvent(t, 'PRIORITY_UPDATED', { from: t.priority, to: b.priority });
        }
        if (t.team?.id !== team.id) {
          addEvent(t, t.team ? 'TEAM_REASSIGNED' : 'TEAM_ASSIGNED', { to: team.id });
        }
        if ((t.assignee?.id ?? null) !== (assignee?.id ?? null)) {
          addEvent(t, 'ASSIGNEE_UPDATED', { to: assignee?.id ?? null });
        }
        t.category = { id: category.id, name: category.name };
        t.priority = b.priority;
        t.team = { id: team.id, name: team.name };
        t.assignee = assignee ? { id: assignee.id, name: assignee.displayName } : null;
        if (t.status === 'OPEN') {
          addEvent(t, 'STATUS_CHANGED', { from: 'OPEN', to: 'TRIAGED' });
          t.status = 'TRIAGED';
        }
        t.version = before + 1;
        return reply(route, 200, dto(), 'Routing approved');
      }

      if (method === 'POST' && sub === 'transitions') {
        const b = req.postDataJSON() as {
          to: TicketStatus;
          expectedVersion: number;
          resolutionSummary?: string;
        };
        if (b.expectedVersion !== t.version) return conflict();
        const allowed: Record<TicketStatus, TicketStatus[]> = {
          OPEN: ['TRIAGED'],
          TRIAGED: ['IN_PROGRESS'],
          IN_PROGRESS: ['RESOLVED'],
          RESOLVED: ['CLOSED', 'OPEN'],
          CLOSED: ['OPEN'],
        };
        if (!allowed[t.status].includes(b.to)) {
          return reply(route, 409, null, `A ${t.status} ticket cannot move to ${b.to}`, {
            code: 'INVALID_TRANSITION',
          });
        }
        if (b.to === 'RESOLVED' && !b.resolutionSummary?.trim()) {
          return reply(route, 422, null, 'A resolution summary is required');
        }
        const before = t.version;
        const from = t.status;
        if (b.to === 'RESOLVED') {
          t.resolvedAt = tick();
          t.resolutionSummary = b.resolutionSummary!.trim();
          addEvent(t, 'RESOLVED', { from });
        } else if (b.to === 'OPEN') {
          t.resolvedAt = null;
          t.resolutionSummary = null;
          addEvent(t, 'REOPENED', { from });
        } else {
          addEvent(t, 'STATUS_CHANGED', { from, to: b.to });
        }
        t.status = b.to;
        t.version = before + 1;
        return reply(route, 200, dto(), 'Ticket updated');
      }
      return reply(route, 404, null, 'Not found');
    }

    const match = /^\/([^/]+)(\/comments)?$/.exec(path);
    const target = match && tickets.find((t) => t.id === match[1]);
    // Someone else's ticket is indistinguishable from a missing one, as in the real API.
    if (!match || !target || target.requesterId !== session.id) {
      return reply(route, 404, null, 'Ticket not found');
    }
    if (method === 'GET' && !match[2]) return reply(route, 200, detail(target));
    if (method === 'POST' && match[2]) {
      const body = req.postDataJSON() as { body?: unknown; isInternal?: unknown };
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!text || text.length > 5000) return reply(route, 400, null, 'Validation failed');
      if (body.isInternal === true) return reply(route, 403, null, 'Forbidden');
      const comment: MockComment = {
        id: uuid(5, ++commentSeq),
        body: text,
        isInternal: false,
        author: { id: session.id, name: session.displayName },
        createdAt: tick(),
      };
      target.comments.push(comment);
      return reply(route, 201, comment, 'Comment added');
    }
    return reply(route, 404, null, 'Not found');
  });

  // --- Knowledge base ------------------------------------------------------------------------
  const ARTICLE_ID = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let articleSeq = 0;
  let articleClock = Date.UTC(2026, 1, 1);
  const articles: MockArticle[] = [];
  const addArticle = (a: {
    title: string;
    body: string;
    categoryId?: string | null;
    isPublished?: boolean;
  }): MockArticle => {
    const stamp = new Date((articleClock += 60_000)).toISOString();
    const article: MockArticle = {
      id: ARTICLE_ID(++articleSeq),
      title: a.title,
      body: a.body,
      categoryId: a.categoryId ?? null,
      isPublished: a.isPublished ?? false,
      createdAt: stamp,
      updatedAt: stamp,
    };
    articles.push(article);
    return article;
  };
  addArticle({
    title: 'Fix a VPN that disconnects repeatedly',
    body: 'If the VPN client drops every hour, renew the VPN profile certificate.\n\n- Sign out of the VPN client\n- Sign in again\n\nCheck that the **hardware token** has not expired.',
    categoryId: 'c0000000-0000-4000-8000-000000000003',
    isPublished: true,
  });
  addArticle({
    title: 'Clear a printer paper jam and restart the queue',
    body: 'Open the printer tray, remove the jammed paper and restart the print spooler.',
    categoryId: 'c0000000-0000-4000-8000-000000000001',
    isPublished: true,
  });
  addArticle({
    title: 'Reset a forgotten or locked password',
    body: 'Use the self-service portal to reset your password.',
    categoryId: 'c0000000-0000-4000-8000-000000000002',
    isPublished: true,
  });
  addArticle({
    title: 'Draft: laptop onboarding checklist',
    body: 'Work in progress. Steps for provisioning a new laptop.',
    categoryId: 'c0000000-0000-4000-8000-000000000001',
    isPublished: false,
  });

  const catRef = (id: string | null) => {
    const c = CATEGORIES.find((x) => x.id === id);
    return c ? { id: c.id, name: c.name } : null;
  };
  const articleSummary = (a: MockArticle) => ({
    id: a.id,
    title: a.title,
    category: catRef(a.categoryId),
    updatedAt: a.updatedAt,
  });
  const articleDetail = (a: MockArticle) => ({
    ...articleSummary(a),
    body: a.body,
    createdAt: a.createdAt,
  });
  const pageOf = <T>(rows: T[], limit: number, offset: number) => ({
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
  });
  const newest = (a: MockArticle, b: MockArticle) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

  await page.route(/\/api\/(admin\/)?knowledge/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(route) });
    if (offline) return route.abort('failed');
    if (!session) return reply(route, 401, null, 'Authentication required');
    const url = new URL(req.url());
    const admin = url.pathname.startsWith('/api/admin/');
    const path = url.pathname.replace(/^\/api\/(admin\/)?knowledge/, '');
    const method = req.method();
    const q = url.searchParams;
    const limit = Number(q.get('limit') ?? 20);
    const offset = Number(q.get('offset') ?? 0);
    if (admin && session.role !== 'ADMIN') return reply(route, 403, null, 'Forbidden');
    const stamp = () => new Date((articleClock += 60_000)).toISOString();
    const active = (id: string | null | undefined) => !id || CATEGORIES.some((c) => c.id === id);

    if (!admin) {
      const visible = articles.filter((a) => a.isPublished);
      const byCategory = (rows: MockArticle[]) =>
        q.get('categoryId') ? rows.filter((a) => a.categoryId === q.get('categoryId')) : rows;
      if (method === 'GET' && path === '/categories') {
        const used = new Set(visible.map((a) => a.categoryId));
        return reply(
          route,
          200,
          CATEGORIES.filter((c) => used.has(c.id)),
        );
      }
      if (method === 'GET' && path === '/search') {
        const terms = (q.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return reply(route, 200, pageOf([], limit, offset));
        const inTitle = (a: MockArticle) => terms.some((t) => a.title.toLowerCase().includes(t));
        const hits = byCategory(visible)
          .filter((a) => terms.every((t) => `${a.title} ${a.body}`.toLowerCase().includes(t)))
          .sort((a, b) => Number(inTitle(b)) - Number(inTitle(a)) || newest(a, b))
          .map((a) => ({
            id: a.id,
            title: a.title,
            category: catRef(a.categoryId),
            preview: a.body.replace(/\s+/g, ' ').slice(0, 200),
            rank: 1,
          }));
        return reply(route, 200, pageOf(hits, limit, offset));
      }
      if (method === 'GET' && path === '') {
        const rows = byCategory(visible).sort(newest).map(articleSummary);
        return reply(route, 200, pageOf(rows, limit, offset));
      }
      const one = /^\/([^/]+)$/.exec(path);
      const found = one ? visible.find((a) => a.id === one[1]) : undefined;
      if (method === 'GET' && one) {
        return found
          ? reply(route, 200, articleDetail(found))
          : reply(route, 404, null, 'Article not found');
      }
      return reply(route, 404, null, 'Not found');
    }

    // Administrator surface.
    const withState = (a: MockArticle) => ({ ...articleDetail(a), isPublished: a.isPublished });
    if (method === 'GET' && path === '') {
      const published = q.get('published');
      const rows = articles
        .filter((a) => published === null || a.isPublished === (published === 'true'))
        .sort(newest)
        .map((a) => ({ ...articleSummary(a), isPublished: a.isPublished }));
      return reply(route, 200, pageOf(rows, limit, offset));
    }
    if (method === 'POST' && path === '') {
      const b = req.postDataJSON() as { title?: string; body?: string; categoryId?: string | null };
      if (!b.title?.trim() || !b.body?.trim()) return reply(route, 400, null, 'Validation failed');
      if (!active(b.categoryId)) return reply(route, 422, null, 'Category is unknown or inactive');
      const created = addArticle({
        title: b.title.trim(),
        body: b.body.trim(),
        categoryId: b.categoryId,
      });
      return reply(route, 201, withState(created), 'Article created');
    }
    const match = /^\/([^/]+)(?:\/(publish|unpublish))?$/.exec(path);
    const target = match ? articles.find((a) => a.id === match[1]) : undefined;
    if (!match || !target) return reply(route, 404, null, 'Article not found');
    if (method === 'GET' && !match[2]) return reply(route, 200, withState(target));
    if (method === 'PATCH' && !match[2]) {
      const b = req.postDataJSON() as { title?: string; body?: string; categoryId?: string | null };
      if (b.title !== undefined && !b.title.trim()) {
        return reply(route, 400, null, 'Validation failed');
      }
      if (b.body !== undefined && !b.body.trim()) {
        return reply(route, 400, null, 'Validation failed');
      }
      if (b.categoryId !== undefined && !active(b.categoryId)) {
        return reply(route, 422, null, 'Category is unknown or inactive');
      }
      if (b.title !== undefined) target.title = b.title.trim();
      if (b.body !== undefined) target.body = b.body.trim();
      if (b.categoryId !== undefined) target.categoryId = b.categoryId;
      target.updatedAt = stamp();
      return reply(route, 200, withState(target), 'Article updated');
    }
    if (method === 'POST' && match[2]) {
      const want = match[2] === 'publish';
      if (target.isPublished !== want) {
        target.isPublished = want;
        target.updatedAt = stamp();
      }
      return reply(
        route,
        200,
        withState(target),
        want ? 'Article published' : 'Article unpublished',
      );
    }
    return reply(route, 404, null, 'Not found');
  });

  await page.route(/\/api\/notifications/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(route) });
    if (offline) return route.abort('failed');
    const auth = req.headers()['authorization'];
    if (!session || auth !== `Bearer ${currentToken}`) {
      return reply(route, 401, null, 'Authentication required');
    }
    const failure = notificationsDown ?? failures.get('notifications');
    if (failure !== undefined) {
      failures.delete('notifications');
      return failure === 'network'
        ? route.abort('failed')
        : reply(route, failure, null, 'Server error');
    }
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/notifications', '');
    const mine = notifications.filter((n) => n.recipientId === session!.id);
    const unreadCount = () => mine.filter((n) => !n.readAt).length;
    const dto = (n: MockNotification) => ({
      id: n.id,
      type: n.type,
      message: n.message,
      ticketId: n.ticketId,
      trackingId: n.ticketId,
      ticketTitle: n.ticketTitle,
      read: n.readAt !== null,
      readAt: n.readAt,
      createdAt: n.createdAt,
    });

    if (req.method() === 'GET' && path === '') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
      const matching = [...mine].reverse().filter((n) => !unreadOnly || !n.readAt);
      const items = matching.slice(offset, offset + limit).map(dto);
      return reply(route, 200, {
        items,
        total: matching.length,
        limit,
        offset,
        nextOffset: offset + items.length < matching.length ? offset + items.length : null,
        unreadCount: unreadCount(),
      });
    }
    if (req.method() === 'POST' && path === '/read-all') {
      let updated = 0;
      for (const n of mine) {
        if (!n.readAt) {
          n.readAt = tick();
          updated++;
        }
      }
      return reply(route, 200, { unreadCount: 0, updated }, 'Notifications marked read');
    }
    const read = /^\/([^/]+)\/read$/.exec(path);
    if (req.method() === 'PATCH' && read) {
      const target = mine.find((n) => n.id === read[1]);
      if (!target) return reply(route, 404, null, 'Notification not found');
      target.readAt ??= tick();
      return reply(route, 200, { unreadCount: unreadCount() }, 'Notification marked read');
    }
    return reply(route, 404, null, 'Not found');
  });

  const api: MockApi = {
    notifications: () => notifications,
    setNotificationsDown: (status) => {
      notificationsDown = status;
    },
    knowledge: { articles: () => articles, seed: addArticle },
    tickets: () => tickets,
    seedTickets: (n, requesterId = ACCOUNTS.employee.id) =>
      Array.from({ length: n }, (_, i) =>
        newTicket(requesterId, `Seeded ticket ${i + 1}`, `Description ${i + 1}`),
      ),
    seedForeignTicket: () => newTicket('u-omar', 'Omar private issue', 'Not yours'),
    technician: {
      update(id, change) {
        const t = tickets.find((x) => x.id === id);
        if (!t) throw new Error(`no ticket ${id}`);
        if (change.category) {
          const category = CATEGORIES.find((c) => c.name === change.category);
          addEvent(t, 'CATEGORY_UPDATED', { to: category?.id ?? 'c1' });
          t.category = { id: category?.id ?? 'c1', name: change.category };
        }
        if (change.team) {
          const team = TEAMS.find((x) => x.name === change.team);
          addEvent(t, 'TEAM_ASSIGNED', { to: team?.id ?? 't1' });
          t.team = { id: team?.id ?? 't1', name: change.team };
          t.assignee = { id: 'u-tara', name: ACCOUNTS.technician.displayName };
          notify(t, 'TICKET_ASSIGNED');
        }
        if (change.priority) {
          addEvent(t, 'PRIORITY_UPDATED', { from: t.priority, to: change.priority });
          t.priority = change.priority;
        }
        if (change.status) {
          const from = t.status;
          if (change.status === 'RESOLVED') {
            t.resolvedAt = tick();
            t.resolutionSummary = change.resolutionSummary ?? 'Fixed.';
            addEvent(t, 'RESOLVED', { from });
            notify(t, 'TICKET_RESOLVED');
          } else {
            addEvent(t, 'STATUS_CHANGED', { from, to: change.status });
            notify(t, 'TICKET_STATUS_CHANGED');
          }
          t.status = change.status;
        }
      },
      suggest(id, proposal) {
        const t = tickets.find((x) => x.id === id);
        if (!t) throw new Error(`no ticket ${id}`);
        const category = CATEGORIES.find((c) => c.name === proposal.category);
        const team = TEAMS.find((x) => x.name === proposal.team);
        const rec: MockRecommendation = {
          id: uuid(7, ++recSeq),
          createdAt: tick(),
          modelVersion: 'fake-model-1',
          confidence: 0.82,
          suggestion: proposal.suggestion ?? 'Restart the service and check the logs.',
          proposed: {
            category: category ? { id: category.id, name: category.name, isActive: true } : null,
            team: team ? { id: team.id, name: team.name, isActive: true } : null,
            priority: proposal.priority ?? null,
          },
          review: { status: 'PENDING', reviewer: null, reviewedAt: null, notes: null },
          articles: [],
        };
        t.recommendations.unshift(rec);
        return rec;
      },
      setAnalysis(id, change) {
        const t = tickets.find((x) => x.id === id);
        if (!t) throw new Error(`no ticket ${id}`);
        t.analysis = { ...t.analysis, ...change, updatedAt: tick() };
      },
      finishAnalysis(id, proposal) {
        const t = tickets.find((x) => x.id === id);
        if (!t) throw new Error(`no ticket ${id}`);
        t.analysis = {
          ...t.analysis,
          state: 'COMPLETED',
          failure: null,
          retryAt: null,
          updatedAt: tick(),
        };
        return api.technician.suggest(id, proposal);
      },
      deactivate(kind, name) {
        const list = kind === 'category' ? CATEGORIES : TEAMS;
        const item = list.find((x) => x.name === name);
        if (!item) throw new Error(`no ${kind} ${name}`);
        inactive.add(item.id);
        for (const t of tickets) {
          for (const r of t.recommendations) {
            const ref = kind === 'category' ? r.proposed.category : r.proposed.team;
            if (ref?.id === item.id) ref.isActive = false;
          }
        }
      },
      reply(id, body, isInternal = false) {
        const t = tickets.find((x) => x.id === id);
        if (!t) throw new Error(`no ticket ${id}`);
        t.comments.push({
          id: uuid(5, ++commentSeq),
          body,
          isInternal,
          author: { id: 'u-tara', name: ACCOUNTS.technician.displayName },
          createdAt: tick(),
        });
        addEvent(t, 'COMMENT_ADDED', { isInternal });
        if (!isInternal) notify(t, 'TECHNICIAN_REPLY');
      },
    },
    setAiEnabled: (v) => {
      aiEnabled = v;
    },
    limitAnalysis: (v) => {
      analysisLimited = v;
    },
    analysisRequests: () => analysisRequestIds,
    failNext: (endpoint, status) => {
      failures.set(endpoint, status);
    },
    createRequests: () => createRequests,
    createKeys: () => createKeys,
    adminUsers: () => users,
    reportRequests: () => reportLog,
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
  return api;
}
