import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const gateway = 'http://127.0.0.1:4000';
const reports = '/api/admin/reports/summary?start=2026-03-01&end=2026-04-01';
const timeout = Number(process.env.SD100_TIMEOUT_MS ?? 2500);
const mode = process.argv[2];
const session = JSON.parse(process.env.SD100_SESSION || '{}');

async function request(
  path,
  { origin = gateway, method = 'GET', token, body, expected = 200, id } = {},
) {
  const started = performance.now();
  const response = await fetch(new URL(path, origin), {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...(token && { authorization: 'Bearer ' + token }),
      ...(body && { 'content-type': 'application/json' }),
      ...(id && { 'x-request-id': id }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await response.json();
  const duration = performance.now() - started;
  assert.equal(response.status, expected, `${method} ${path}`);
  assert.ok(response.headers.get('x-request-id'), `${method} ${path} has no request ID`);
  if (id) assert.equal(response.headers.get('x-request-id'), id);
  if (expected < 400) assert.equal(data.error, null, `${method} ${path} returned an error`);
  return { data: data.data, duration, headers: response.headers };
}

async function login(name) {
  const { data } = await request('/api/auth/login', {
    method: 'POST',
    body: { email: name + '@smartdesk.test', password: 'SmartDesk-Demo-1!' },
  });
  return data;
}

async function createTicket(token, title) {
  return request('/api/tickets', {
    method: 'POST',
    token,
    expected: 201,
    body: { title, description: 'Synthetic VPN disconnect during a network change.' },
  });
}

if (mode === 'benchmark') {
  const employee = (await login('erin')).accessToken;
  const technician = (await login('tara')).accessToken;
  const admin = (await login('admin')).accessToken;
  const operations = {
    teams: () => request('/api/teams', { token: technician }),
    report: () => request(reports, { token: admin }),
    submit: (round) => createTicket(employee, `SD100 measurement ${round}`),
  };
  for (let round = 0; round < 4; round++) {
    await Promise.all(Object.values(operations).map((run) => run('warmup-' + round)));
  }
  const samples = { teams: [], report: [], submit: [] };
  let failures = 0;
  const start = new Date();
  for (let round = 0; round < 30; round++) {
    await Promise.all(
      Object.entries(operations).map(async ([kind, run]) => {
        try {
          samples[kind].push((await run(round)).duration);
        } catch (error) {
          console.error(kind, error.name);
          failures++;
        }
      }),
    );
    await setTimeout(200);
  }
  const end = new Date();
  const result = Object.fromEntries(
    Object.entries(samples).map(([kind, series]) => {
      series.sort((a, b) => a - b);
      const percentile = (p) =>
        series.length ? Number(series[Math.ceil(p * series.length) - 1].toFixed(2)) : null;
      return [
        kind,
        {
          count: series.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
        },
      ];
    }),
  );
  console.log(JSON.stringify({ start, end, failures, result }, null, 2));
  assert.equal(failures, 0);
} else if (mode === 'roles') {
  const { employee, other, technician, admin } = session;
  const { data: ticket } = await createTicket(employee, 'SD100 role matrix');
  const ticketPath = '/api/tickets/' + ticket.id;
  await request(ticketPath, { token: other, expected: 404 });
  await request(ticketPath, { token: employee });
  await request(ticketPath, { token: technician });
  await request(reports, { token: employee, expected: 403 });
  await request(reports, { token: technician, expected: 403 });
  await request(reports, { token: admin });
  // Exercise the same authorization directly on the private listener used by the gateway.
  await request(ticketPath, { origin: 'http://ticket-api:4060', token: other, expected: 404 });
  await request(reports, { origin: 'http://analytics-api:4030', token: employee, expected: 403 });
  await request('/api/admin/knowledge', {
    origin: 'http://knowledge-api:4040',
    token: employee,
    expected: 403,
  });
  await request('/internal/tickets/analysis-jobs/claim', { method: 'POST', expected: 404 });
  await request('/internal/tickets/analysis-jobs/claim', {
    origin: 'http://ticket-api:4060',
    method: 'POST',
    token: employee,
    expected: 401,
  });
  await request('/internal/identity/ticket-principal', {
    origin: 'http://identity-api:4050',
    token: employee,
    expected: 401,
  });
  await request('/internal/knowledge/published-retrieval', {
    origin: 'http://knowledge-api:4040',
    method: 'POST',
    body: { terms: ['vpn'] },
    token: employee,
    expected: 401,
  });
  console.log('SD-100 role matrix and direct-listener authorization passed');
} else if (mode === 'identity') {
  await request('/api/tickets', {
    token: session.employee,
    expected: 503,
    id: 'sd100-identity-unavailable',
  });
  console.log('SD-100 Ticket failed closed during the Identity outage');
} else if (mode === 'session') {
  const users = { employee: 'erin', other: 'omar', technician: 'tara', admin: 'admin' };
  const tokens = await Promise.all(
    Object.entries(users).map(async ([role, name]) => [role, (await login(name)).accessToken]),
  );
  process.stdout.write(JSON.stringify(Object.fromEntries(tokens)));
} else if (mode === 'enqueue') {
  const { data } = await createTicket(session.employee, 'SD100 worker recovery');
  process.stdout.write(data.id);
} else if (mode === 'search-ready') {
  const { data } = await request('/api/tickets/search?q=vpn', { token: session.employee });
  assert.equal(data.consistency, 'eventual');
  assert.ok(data.items.length > 0);
} else {
  const { employee, admin } = session;
  if (mode === 'analytics') {
    const { duration } = await request(reports, {
      token: admin,
      expected: 503,
      id: 'sd100-analytics-timeout',
    });
    assert.ok(
      duration >= timeout * 0.9 && duration <= timeout + 3000,
      'Expected a bounded timeout',
    );
    console.log(`SD-100 paused Analytics timed out in ${duration.toFixed(1)} ms`);
  }
  if (mode === 'knowledge')
    await request('/api/knowledge/search?q=vpn', { token: employee, expected: 503 });
  if (mode === 'notifications')
    await request('/api/notifications', { token: employee, expected: 503 });
  if (mode === 'search') {
    const { data } = await request('/api/tickets/search?q=vpn', { token: employee });
    assert.equal(data.mode, 'fallback');
    assert.equal(data.reason, 'unavailable');
  }
  const { data: ticket } = await createTicket(employee, `SD100 manual during ${mode} outage`);
  const categories = (await request('/api/categories', { token: admin })).data;
  const teams = (await request('/api/teams', { token: admin })).data;
  const path = '/api/tickets/' + ticket.id;
  const { data: routed } = await request(path + '/routing', {
    method: 'POST',
    token: admin,
    body: {
      teamId: teams[0].id,
      categoryId: categories[0].id,
      priority: 'HIGH',
      expectedVersion: ticket.version,
    },
  });
  assert.equal(routed.status, 'TRIAGED');
  const { data: events } = await request(path + '/events', { token: admin });
  assert.equal(events.filter(({ type }) => type === 'CREATED').length, 1);
  assert.equal(events.filter(({ type }) => type === 'TEAM_ASSIGNED').length, 1);
  if (mode === 'search') {
    const { data: hits } = await request('/api/tickets/search?q=SD100', { token: employee });
    assert.equal(hits.mode, 'fallback');
    assert.equal(hits.consistency, 'current');
    assert.ok(hits.items.some(({ id }) => id === ticket.id));
  }
  console.log(`SD-100 manual submission, routing, and audit passed during ${mode} outage`);
}
