// SD-057: sustained 100-user load against the isolated SmartDesk stack (gateway -> services ->
// PostgreSQL) with the fake AI provider. Run by `SD100=1 SD100_PERF=1 sh docker/verify-ticket-service.sh`.
//
// Users are synthetic accounts seeded into the disposable database. Their access tokens are minted
// by the Identity service before the run (TOKENS_FILE), because the login endpoint is limited to
// 10 attempts per minute per address and every VU shares one address. Login is not under test.
//
// Thresholds mirror the Deliverable 1 targets. They are reported, not enforced: the gate records a
// threshold miss (k6 exit 99) as a measured result instead of failing the build.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.GATEWAY_URL || 'http://gateway:4000';
const HOLD = __ENV.PERF_HOLD || '5m';
const tokens = JSON.parse(open(__ENV.TOKENS_FILE || '/secrets/perf-tokens.json'));
const teamId = tokens.teamId;

const aiAnalysis = new Trend('ai_analysis_ms', true);

export const options = {
  discardResponseBodies: false,
  scenarios: {
    employees: {
      executor: 'ramping-vus',
      exec: 'employee',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 80 },
        { duration: HOLD, target: 80 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
    technicians: {
      executor: 'ramping-vus',
      exec: 'technician',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 18 },
        { duration: HOLD, target: 18 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
    admins: {
      executor: 'ramping-vus',
      exec: 'admin',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 2 },
        { duration: HOLD, target: 2 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
    // Not a VU of the 100: one probe at a time measures submit-to-suggestion turnaround.
    aiTurnaround: {
      executor: 'constant-vus',
      exec: 'aiProbe',
      vus: 1,
      startTime: '1m',
      duration: HOLD,
    },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<500'],
    'http_req_duration{kind:submit}': ['p(95)<2000'],
    ai_analysis_ms: ['p(95)<10000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

function headers(token, extra = {}) {
  return {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
  };
}

function get(token, path, name) {
  const res = http.get(`${BASE}${path}`, { ...headers(token), tags: { kind: 'read', name } });
  check(res, { [`${name} 200`]: (r) => r.status === 200 });
  return res;
}

function submit(token, label) {
  const body = JSON.stringify({
    title: `Load test ${label}`,
    description: 'Synthetic VPN disconnect reported during the sustained load benchmark.',
  });
  const res = http.post(`${BASE}/api/tickets`, body, {
    ...headers(token),
    tags: { kind: 'submit', name: 'submit' },
  });
  check(res, { 'submit 201': (r) => r.status === 201 });
  return res.status === 201 ? res.json('data.id') : null;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const think = () => sleep(1 + Math.random() * 2);

export function employee() {
  const token = tokens.employees[(exec.vu.idInTest - 1) % tokens.employees.length];
  const list = get(token, '/api/tickets?limit=20', 'my tickets');
  const items = list.status === 200 ? list.json('data.items') || [] : [];
  think();
  if (items.length) {
    const id = pick(items).id;
    get(token, `/api/tickets/${id}`, 'ticket detail');
    get(token, `/api/tickets/${id}/comments`, 'ticket comments');
    think();
  }
  // About one submission per five iterations per employee.
  if (Math.random() < 0.2) {
    submit(token, `employee ${exec.vu.idInTest}-${exec.vu.iterationInScenario}`);
    think();
  }
  get(token, '/api/notifications?unreadOnly=true', 'notifications');
  think();
}

export function technician() {
  const token = tokens.technicians[(exec.vu.idInTest - 1) % tokens.technicians.length];
  const queue = get(token, `/api/technician/queue?teamId=${teamId}&limit=20`, 'team queue');
  const items = queue.status === 200 ? queue.json('data.items') || [] : [];
  think();
  get(token, '/api/technician/unassigned?limit=20', 'unrouted backlog');
  if (items.length) {
    const id = pick(items).id;
    get(token, `/api/tickets/${id}`, 'ticket detail');
    get(token, `/api/tickets/${id}/events`, 'ticket events');
  }
  think();
  get(token, '/api/teams', 'teams');
  think();
}

export function admin() {
  const token = tokens.admins[(exec.vu.idInTest - 1) % tokens.admins.length];
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const window = `start=${start.toISOString()}&end=${end.toISOString()}`;
  get(token, `/api/admin/reports/summary?${window}`, 'report summary');
  think();
  get(token, `/api/admin/reports/ai-evaluation?${window}`, 'ai evaluation');
  sleep(3 + Math.random() * 3);
}

/** Submit as an employee, then poll the staff analysis status until a suggestion is ready. */
export function aiProbe() {
  const id = submit(pick(tokens.employees), `ai probe ${exec.vu.iterationInScenario}`);
  if (!id) return sleep(2);
  const started = Date.now();
  const staff = pick(tokens.technicians);
  for (;;) {
    const res = http.get(`${BASE}/api/tickets/${id}/analysis`, {
      ...headers(staff),
      tags: { kind: 'ai-poll', name: 'analysis status' },
    });
    const state = res.status === 200 ? res.json('data.state') : null;
    if (state === 'COMPLETED') {
      aiAnalysis.add(Date.now() - started);
      break;
    }
    if (state === 'FAILED' || Date.now() - started > 30_000) {
      check(null, { 'ai analysis completed within 30 s': () => false });
      break;
    }
    sleep(0.25);
  }
  sleep(2);
}

export function handleSummary(data) {
  return {
    '/out/perf-summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

function textSummary(data) {
  const lines = ['SD-057 k6 summary'];
  for (const [name, metric] of Object.entries(data.metrics)) {
    if (metric.type !== 'trend' && metric.type !== 'rate' && metric.type !== 'counter') continue;
    lines.push(`${name}: ${JSON.stringify(metric.values)}`);
    for (const [threshold, result] of Object.entries(metric.thresholds || {})) {
      lines.push(`  threshold ${threshold}: ${result.ok ? 'MET' : 'NOT MET'}`);
    }
  }
  return lines.join('\n') + '\n';
}
