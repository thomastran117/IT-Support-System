#!/bin/sh
set -eu

unset COMPOSE_PROFILES
export BACKEND_PORT=127.0.0.1:0
export POSTGRES_USER=smartdesk POSTGRES_PASSWORD=smartdesk POSTGRES_DB=smartdesk
export AI_PROVIDER=fake AI_EXECUTION_MODE=service WORKER_POLL_INTERVAL_MS=200
export LOG_LEVEL=info AI_SERVICE_API_KEY=SD099_FIXTURE_PROVIDER_KEY
export OPENSEARCH_ENABLED=false EMAIL_TRANSPORT=none REDIS_URL=
export JWT_SECRET=ticket-ci-shared-session-key-for-test-fixtures
export TICKET_SEARCH_CURSOR_SECRET=ticket-ci-search-key-for-test-fixtures-only
export TICKET_DATABASE_URL=postgres://ticket_test:ticket-test-only@postgres:5432/smartdesk
export IDENTITY_DATABASE_URL=postgres://identity_test:identity-test-only@postgres:5432/smartdesk
export KNOWLEDGE_DATABASE_URL=postgres://knowledge_test:knowledge-test-only@postgres:5432/smartdesk
export ANALYTICS_DATABASE_URL=postgres://analytics_test:analytics-test-only@postgres:5432/smartdesk
export NOTIFICATIONS_DATABASE_URL=postgres://notifications_test:notifications-test-only@postgres:5432/smartdesk
export TICKET_IDENTITY_KEY_ID=ticket-ci AI_SERVICE_KEY_ID=ai-ci
export KNOWLEDGE_KEY_ID=knowledge-ci ANALYTICS_KEY_ID=analytics-ci NOTIFICATIONS_KEY_ID=notifications-ci

project=smartdesk-ticket-ci-$$
legacy() { docker compose -p "$project" --env-file .env.example -f docker-compose.yml "$@"; }
compose() { legacy -f docker/compose.ticket-service.yml --profile services "$@"; }
trap 'compose --profile legacy down --remove-orphans -v' EXIT

keys=$(node --input-type=module - <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
function generate(service, grants) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, entry: { kid: service + '-ci', service, publicKey, grants } };
}
const services = {
  TICKET_IDENTITY: generate('ticket', { 'identity:ticket-principal': 'user' }),
  KNOWLEDGE: generate('knowledge', { 'identity:knowledge-principal': 'user' }),
  ANALYTICS: generate('analytics', { 'identity:analytics-principal': 'user' }),
  NOTIFICATIONS: generate('notifications', { 'identity:notification-recipient': 'user' }),
  AI_SERVICE: generate('ai', Object.fromEntries(['claim', 'inputs', 'complete', 'fail']
    .map((action) => ['ticket:analysis-' + action, 'system']))),
};
process.stdout.write(JSON.stringify({
  ...Object.fromEntries(Object.entries(services).map(([name, { privateKey }]) => [name, privateKey])),
  registry: Object.values(services).map(({ entry }) => entry),
  retrieval: [{ ...services.AI_SERVICE.entry, grants: { 'knowledge:published-retrieval': 'system' } }],
}));
NODE
)
key_field() {
  printf '%s' "$keys" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"))[process.argv[1]];
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1"
}
for name in TICKET_IDENTITY KNOWLEDGE ANALYTICS NOTIFICATIONS AI_SERVICE; do
  export "${name}_PRIVATE_KEY=$(key_field "$name")"
done
INTERNAL_SERVICE_KEYS=$(key_field registry)
KNOWLEDGE_RETRIEVAL_KEYS=$(key_field retrieval)
unset keys
export INTERNAL_SERVICE_KEYS KNOWLEDGE_RETRIEVAL_KEYS

compose config --format json | node -e '
  const assert = require("node:assert/strict");
  const { services, networks } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.equal(services.backend, undefined);
  assert.equal(services.worker, undefined);
  assert.equal(services["search-indexer"], undefined);
  assert.ok(networks.api.internal && networks.internal.internal && networks.search.internal);
  assert.deepEqual(Object.keys(services.gateway.depends_on), ["ticket-service"]);
  assert.deepEqual(Object.keys(services["ai-service"].depends_on), ["ticket-service"]);
  assert.equal(services["ai-service"].environment.AI_SERVICE_TICKET_ORIGIN, "http://ticket-api:4060");
  for (const name of ["ticket", "identity", "knowledge", "analytics", "notifications", "ai"]) {
    assert.equal((services[name + "-service"].ports ?? []).length, 0);
  }
  assert.ok(!Object.hasOwn(services["ticket-service"].environment, "DATABASE_URL"));
  assert.ok(!Object.hasOwn(services["ticket-service"].environment, "JWT_SECRET"));
'
compose --profile search config --format json | node -e '
  const assert = require("node:assert/strict");
  const { services } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const indexer = services["search-indexer"];
  assert.deepEqual(Object.keys(indexer.networks).sort(), ["internal", "search"]);
  assert.ok(Object.hasOwn(indexer.environment, "SEARCH_DATABASE_URL"));
  assert.ok(!Object.hasOwn(indexer.environment, "TICKET_DATABASE_URL"));
'

legacy build backend
compose build ticket-service gateway identity-service knowledge-service analytics-service notifications-service ai-service
compose up -d --wait postgres
legacy run --rm --no-deps backend sh -c 'npm run migrate && npm run db:seed -- --profile test'
psql() { compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk; }
psql < backend/sql/service-access/roles.sql
psql < backend/sql/service-access/enable.sql
psql <<'SQL'
CREATE ROLE ticket_test LOGIN PASSWORD 'ticket-test-only';
GRANT smartdesk_ticket TO ticket_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
CREATE ROLE identity_test LOGIN PASSWORD 'identity-test-only';
GRANT smartdesk_identity TO identity_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
CREATE ROLE knowledge_test LOGIN PASSWORD 'knowledge-test-only';
GRANT smartdesk_knowledge TO knowledge_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
CREATE ROLE analytics_test LOGIN PASSWORD 'analytics-test-only';
GRANT smartdesk_analytics TO analytics_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
CREATE ROLE notifications_test LOGIN PASSWORD 'notifications-test-only';
GRANT smartdesk_notifications TO notifications_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
SQL

journey() {
  "$1" exec -T -e TICKET_PHASE="$2" -e MANUAL_TICKET_ID="${manual_id:-}" \
    -e TICKET_SNAPSHOT="${snapshot:-}" "$3" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createPrisma } from '@smartdesk/db';

const phase = process.env.TICKET_PHASE;
const root = '/api/tickets';
async function api(path, { method = 'GET', token, body, expected = 200, headers } = {}) {
  const response = await fetch('http://gateway:4000' + path, {
    method, signal: AbortSignal.timeout(15_000),
    headers: {
      ...(token && { authorization: 'Bearer ' + token }),
      ...(body && { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  assert.equal(response.status, expected, phase + ' ' + method + ' ' + path);
  return { body: await response.json(), headers: response.headers };
}
const get = (path, token, expected) => api(path, { token, expected }).then(({ body }) => body.data);
const post = (path, token, body, expected, headers) => api(path, {
  method: 'POST', token, body, expected, headers,
});
async function login(name) {
  const { body } = await post('/api/auth/login', undefined, {
    email: name + '@smartdesk.test', password: 'SmartDesk-Demo-1!',
  });
  return body.data;
}
const employee = await login('erin');
const admin = await login('admin');
const staff = await login('tara');
const token = employee.accessToken;
const adminToken = admin.accessToken;
const staffToken = staff.accessToken;
const manualPath = root + '/' + process.env.MANUAL_TICKET_ID;
const reports = '/api/admin/reports/summary?start=2026-03-01&end=2026-04-01';
if (phase === 'manual') {
  await get('/api/knowledge/search?q=vpn', token);
  await get(reports, adminToken);
  await get('/api/notifications', token, 503);
  const db = createPrisma(process.env.TICKET_DATABASE_URL);
  try {
    assert.deepEqual(await db.$queryRaw`SELECT current_user::text AS "user"`, [{ user: 'ticket_test' }]);
    await assert.rejects(db.$queryRaw`SELECT password_hash FROM users LIMIT 0`, /permission denied/i);
    await assert.rejects(db.$executeRaw`UPDATE users SET is_active = false WHERE false`, /permission denied/i);
    await assert.rejects(db.$executeRaw`UPDATE knowledge_articles SET is_published = false WHERE false`, /permission denied/i);
    await assert.rejects(db.$executeRaw`UPDATE notifications SET read_at = now() WHERE false`, /permission denied/i);
  } finally {
    await db.$disconnect();
  }
  for (const path of ['/api/auth/me', '/api/admin/users', '/api/knowledge', '/api/admin/reports/summary', '/api/notifications']) {
    const response = await fetch('http://ticket-api:4060' + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 404, path + ' has a duplicate Ticket handler');
    await response.body?.cancel();
  }

  const input = { title: 'Scoped manual ticket', description: 'A device disconnects intermittently.' };
  const requestHeaders = { 'idempotency-key': 'ticket-isolation-manual-1', 'x-request-id': 'ticket-isolation-fixture' };
  const created = await post(root, token, input, 201, requestHeaders);
  const ticket = created.body.data;
  assert.equal(created.headers.get('x-request-id'), requestHeaders['x-request-id']);
  const retry = await post(root, token, input, 200, requestHeaders);
  assert.equal(retry.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(retry.body.data, ticket);
  assert.ok((await get(root, token)).items.some(({ id }) => id === ticket.id));
  assert.ok((await get('/api/technician/unassigned', staffToken)).items.some(({ id }) => id === ticket.id));

  const team = (await get('/api/teams?mine=true', staffToken))[0];
  const category = (await get('/api/categories', staffToken)).find(({ name }) => name === 'Network/VPN');
  await get('/api/admin/teams', adminToken);
  await get('/api/admin/categories', adminToken);
  const path = root + '/' + ticket.id;
  const routing = { teamId: team.id, categoryId: category.id, assigneeId: staff.user.id, priority: 'HIGH', expectedVersion: ticket.version };
  await post(path + '/routing', token, routing, 403);
  const stale = await post(path + '/routing', staffToken, { ...routing, expectedVersion: ticket.version + 1 }, 409);
  assert.equal(stale.body.details.code, 'VERSION_CONFLICT');
  const routed = (await post(path + '/routing', staffToken, routing)).body.data;
  assert.equal(routed.status, 'TRIAGED');
  const other = await login('hana');
  await get(path, other.accessToken, 404);
  assert.ok((await get('/api/technician/queue?teamId=' + team.id, staffToken)).items.some(({ id }) => id === ticket.id));

  await post(path + '/comments', staffToken, { body: 'Internal investigation', isInternal: true }, 201);
  await post(path + '/comments', staffToken, { body: 'Public response', isInternal: false }, 201);
  const current = await get(path, staffToken);
  assert.ok(current.firstResponseAt);
  const active = (await post(path + '/transitions', staffToken, { to: 'IN_PROGRESS', expectedVersion: current.version })).body.data;
  const resolved = (await post(path + '/transitions', staffToken, {
    to: 'RESOLVED', expectedVersion: active.version, resolutionSummary: 'Updated device settings.',
  })).body.data;
  assert.equal(resolved.status, 'RESOLVED');
  assert.deepEqual((await get(path + '/comments', token)).map(({ body }) => body), ['Public response']);
  const audit = await get(path + '/events', staffToken);
  assert.equal(audit.filter(({ type }) => type === 'CREATED').length, 1);
  assert.equal(audit.filter(({ type }) => type === 'TEAM_ASSIGNED').length, 1);
  assert.equal(audit.filter(({ type }) => type === 'RESOLVED').length, 1);
  process.stdout.write(ticket.id);
}
if (phase === 'assisted') {
  const created = await post(root, token, {
    title: 'VPN disconnects repeatedly', description: 'VPN client drops every hour. SD099_PRIVATE_TICKET_DETAIL',
  }, 201, { 'x-request-id': 'sd099-create' });
  assert.equal(created.headers.get('x-request-id'), 'sd099-create');
  const ticket = created.body.data;
  const path = root + '/' + ticket.id;
  const deadline = Date.now() + 45_000;
  const retryUntil = async (getValue, description) => {
    for (;;) {
      const value = await getValue();
      if (value) return value;
      assert.ok(Date.now() < deadline, description);
      await setTimeout(300);
    }
  };
  const proposal = await retryUntil(async () => (await get(path + '/recommendations', adminToken))[0], 'AI did not save a recommendation');
  assert.ok(proposal.articles.some(({ title }) => /VPN/.test(title)));
  const reviewPath = path + '/recommendations/' + proposal.id + '/review';
  await post(reviewPath, adminToken, { decision: 'ACCEPTED', expectedVersion: ticket.version + 1 }, 409);
  assert.equal((await get(path + '/recommendations', adminToken))[0].review.status, 'PENDING');
  const reviewed = await post(reviewPath, adminToken, { decision: 'ACCEPTED', expectedVersion: ticket.version }, 200, {
    'x-request-id': 'sd099-review',
  });
  assert.equal(reviewed.headers.get('x-request-id'), 'sd099-review');
  const review = reviewed.body.data;
  assert.equal(review.recommendationId, proposal.id);
  assert.equal(review.ticket.version, ticket.version + 1);
  assert.equal(review.ticket.categoryId, proposal.proposed.category.id);
  assert.equal((await get(path + '/events', adminToken)).filter(({ type }) => type === 'AI_REVIEWED').length, 1);
  await post('/api/admin/tickets/' + ticket.id + '/classification-label', adminToken, {
    referenceCategoryId: proposal.proposed.category.id,
  }, 201);
  await get('/api/admin/classification-labels', adminToken);
  const notice = await retryUntil(async () => (await get('/api/notifications?limit=50', token)).items.find(
    ({ ticketId, type }) => ticketId === process.env.MANUAL_TICKET_ID && type === 'TICKET_RESOLVED',
  ), 'Notifications did not recover its queued resolution');
  await api('/api/notifications/' + notice.id + '/read', { method: 'PATCH', token });
  await retryUntil(async () => (await get('/api/notifications?limit=50', token)).items.find(
    ({ ticketId, type }) => ticketId === ticket.id && type === 'TICKET_ASSIGNED',
  ), 'Notifications did not deliver the accepted recommendation routing');
  await api('/api/auth/me?trace=SD099_PRIVATE_QUERY', {
    expected: 401,
    headers: { authorization: 'Bearer SD099_PRIVATE_BEARER', cookie: 'session=SD099_PRIVATE_COOKIE' },
  });
  const aiReady = await fetch('http://ai-service:4010/health/ready', {
    signal: AbortSignal.timeout(5000),
    headers: { 'x-request-id': 'sd099-ai-ready' },
  });
  assert.equal(aiReady.status, 200);
  await aiReady.body?.cancel();
  const saved = {
    assistedId: ticket.id,
    manual: await get(manualPath, staffToken),
    recommendations: await get(path + '/recommendations', adminToken),
  };
  process.stdout.write(JSON.stringify(saved));
}
if (phase === 'rollback') {
  const saved = JSON.parse(process.env.TICKET_SNAPSHOT);
  assert.deepEqual(await get(manualPath, staffToken), saved.manual);
  assert.deepEqual(await get(root + '/' + saved.assistedId + '/recommendations', adminToken), saved.recommendations);
  await get('/api/knowledge/search?q=vpn', token);
  await get(reports, adminToken);
}
NODE
}

wait_for_gateway() {
  "$1" exec -T gateway node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
const deadline = Date.now() + 45_000;
for (;;) {
  const response = await fetch('http://127.0.0.1:4000/health/ready', {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  await response?.body?.cancel();
  if (response?.ok) break;
  assert.ok(Date.now() < deadline, 'Ticket did not become ready through the gateway');
  await setTimeout(500);
}
NODE
}

compose up -d --wait gateway identity-service knowledge-service analytics-service
wait_for_gateway compose
window_start=$(node -p 'Date.now()')
manual_id=$(journey compose manual ticket-service)
echo 'Scoped Ticket completed the manual workflow with AI and Notifications stopped.'

compose up -d --wait ai-service notifications-service
snapshot=$(journey compose assisted ticket-service)
echo 'AI completed and Ticket reviewed a recommendation. Notifications delivered its backlog.'
compose stop ticket-service
compose exec -T gateway node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
const response = await fetch('http://127.0.0.1:4000/api/tickets', {
  signal: AbortSignal.timeout(15_000),
  headers: { 'x-request-id': 'sd099-ticket-outage' },
});
assert.equal(response.status, 503);
assert.equal(response.headers.get('x-request-id'), 'sd099-ticket-outage');
await response.body?.cancel();
const aiReady = await fetch('http://ai-service:4010/health/ready', {
  signal: AbortSignal.timeout(5000),
  headers: { 'x-request-id': 'sd099-ai-outage' },
});
assert.equal(aiReady.status, 503);
assert.equal(aiReady.headers.get('x-request-id'), 'sd099-ai-outage');
await aiReady.body?.cancel();
const login = await fetch('http://127.0.0.1:4000/api/auth/login', {
  method: 'POST', signal: AbortSignal.timeout(5000),
  headers: { 'content-type': 'application/json' },
  body: '{"email":"erin@smartdesk.test","password":"SmartDesk-Demo-1!"}',
});
assert.equal(login.status, 200);
await login.body?.cancel();
NODE
window_end=$(node -p 'Date.now()')
compose logs --no-color --no-log-prefix \
  gateway ticket-service identity-service ai-service knowledge-service analytics-service notifications-service \
  | node docker/check-service-observability.mjs "$window_start" "$window_end"

compose down
export AI_EXECUTION_MODE=local
export IDENTITY_EXECUTION_MODE=local KNOWLEDGE_EXECUTION_MODE=local
export ANALYTICS_EXECUTION_MODE=local NOTIFICATIONS_EXECUTION_MODE=local
legacy up -d --wait gateway
wait_for_gateway legacy
journey legacy rollback backend
echo 'Legacy rollback preserved the isolated Ticket and recommendation responses.'
