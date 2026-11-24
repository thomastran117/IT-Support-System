#!/bin/sh
set -eu

unset COMPOSE_PROFILES
export BACKEND_PORT=127.0.0.1:0
export ANALYTICS_EXECUTION_MODE=local NOTIFICATIONS_EXECUTION_MODE=local AI_EXECUTION_MODE=local AI_PROVIDER=none
export POSTGRES_USER=smartdesk POSTGRES_PASSWORD=smartdesk POSTGRES_DB=smartdesk
export ANALYTICS_DATABASE_URL=postgres://analytics_test:analytics-test-only@postgres:5432/smartdesk
export ANALYTICS_KEY_ID=analytics-test ANALYTICS_IDENTITY_ORIGIN=http://backend-api:4000
export CI=true

project=smartdesk-analytics-ci-$$
compose() { docker compose -p "$project" --env-file .env.example --profile analytics "$@"; }
trap 'compose down -v' EXIT

if docker compose --env-file .env.example config --services | grep -qx analytics-service; then
  echo 'The Analytics service must require its explicit profile.' >&2
  exit 1
fi
compose config --format json | node -e '
  const assert = require("node:assert/strict");
  const { services, networks } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const analytics = services["analytics-service"];
  assert.equal((analytics.ports ?? []).length, 0);
  assert.deepEqual(Object.keys(analytics.networks).sort(), ["api", "internal"]);
  assert.ok(networks.api.internal && networks.internal.internal);
  assert.ok(!services.gateway.depends_on["analytics-service"]);
'

keys=$(node --input-type=module - <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.stdout.write(JSON.stringify({
  privateKey,
  registry: [{
    kid: 'analytics-test', service: 'analytics', publicKey,
    grants: { 'identity:analytics-principal': 'user' },
  }],
}));
NODE
)
ANALYTICS_PRIVATE_KEY=$(printf '%s' "$keys" | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).privateKey')
INTERNAL_SERVICE_KEYS=$(printf '%s' "$keys" | node -pe 'JSON.stringify(JSON.parse(require("node:fs").readFileSync(0, "utf8")).registry)')
unset keys
export ANALYTICS_PRIVATE_KEY INTERNAL_SERVICE_KEYS

compose build backend gateway analytics-service
compose run --rm --no-deps analytics-service npm test

wait_for_gateway() {
  compose exec -T backend node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
const deadline = Date.now() + 45_000;
while (true) {
  const response = await fetch('http://gateway:4000/health/ready', {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  await response?.body?.cancel();
  if (response?.ok) break;
  assert.ok(Date.now() < deadline, 'Ticket did not become ready through the gateway');
  await setTimeout(500);
}
NODE
}
compose up -d --wait gateway
wait_for_gateway

psql() { compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk; }
psql < backend/sql/service-access/roles.sql
psql < backend/sql/service-access/enable.sql
psql <<'SQL'
CREATE ROLE analytics_test LOGIN PASSWORD 'analytics-test-only';
GRANT smartdesk_analytics TO analytics_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
SQL
compose exec -T backend npm run db:seed -- --profile test

journey() {
  compose exec -T -e ANALYTICS_PHASE="$1" -e ANALYTICS_BASELINE="${baseline:-}" +    backend node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createPrisma } from '@smartdesk/db';

const phase = process.env.ANALYTICS_PHASE;
async function api(path, { token, headers, body, status = 200 } = {}) {
  const response = await fetch('http://gateway:4000' + path, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(15_000),
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  assert.equal(response.status, status, phase + ' ' + path);
  if (status === 200 && path.startsWith('/api/admin/reports/')) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  return response.json();
}
async function access(name) {
  return (await api('/api/auth/login', {
    body: { email: name + '@smartdesk.test', password: 'SmartDesk-Demo-1!' },
  })).data.accessToken;
}
const admin = await access('admin');
const reports = '/api/admin/reports/';
const summary = reports + 'summary?start=2026-03-01&end=2026-04-01';
if (phase === 'outage') {
  await api(summary, { token: admin, status: 503 });
  const token = await access('erin');
  const { data: ticket } = await api('/api/tickets', {
    token, status: 201, body: { title: 'Analytics outage fixture', description: 'Ticket writes continue.' },
  });
  const { data: stored } = await api('/api/tickets/' + ticket.id, { token });
  assert.equal(stored.status, 'OPEN');
} else {
  const endpoints = ['summary', 'ai-evaluation'];
  const windows = [
    ['2026-03-01', '2026-04-01'],
    ['2026-03-03T05:00:00-05:00', '2026-03-04T08:00:00Z'],
    ['2026-03-06', '2026-03-07'],
    ['2026-05-01', '2026-05-02'],
  ];
  const snapshots = [];
  for (const [start, end] of windows) {
    const params = new URLSearchParams({ start, end });
    snapshots.push(await Promise.all(endpoints.map((endpoint) =>
      api(reports + endpoint + '?' + params, { token: admin }))));
  }
  const [[march, evaluation], [rerouted], [reopened], [empty, emptyEvaluation]] = snapshots;
  assert.equal(march.data.submitted, 9);
  assert.equal(march.data.dailyIntake[0].submittedTickets, 1);
  assert.equal(march.data.dailyIntake.at(-1).date, '2026-03-31');
  assert.equal(evaluation.data.overall.withoutRecommendation, 1);
  assert.deepEqual(rerouted.data.routing, { routed: 1, avgMinutes: 10 });
  assert.deepEqual(reopened.data.resolution, { resolvedTickets: 0, avgHours: null });
  assert.equal(empty.data.routing.avgMinutes, null);
  assert.equal(emptyEvaluation.data.overall.accuracyPct, null);
  if (phase === 'baseline') {
    process.stdout.write(JSON.stringify(snapshots));
  } else {
    assert.deepEqual(snapshots, JSON.parse(process.env.ANALYTICS_BASELINE));
  }
  if (phase === 'service') {
    const technician = await access('tara');
    const employee = await access('erin');
    for (const endpoint of endpoints) {
      const path = reports + endpoint;
      await api(path, { status: 401 });
      for (const token of [technician, employee]) {
        await api(path, { token, status: 403, headers: { 'x-actor-role': 'ADMIN' } });
      }
      await api(path, { token: admin, status: 400 });
    }
    await api('/internal/identity/analytics-principal', { token: admin, status: 404 });
    await api('/api/admin/classification-labels', { token: admin });
    const db = createPrisma(process.env.DATABASE_URL);
    try {
      await db.user.update({ where: { email: 'admin@smartdesk.test' }, data: { role: 'EMPLOYEE' } });
      await api(summary, { token: admin, status: 403 });
    } finally {
      await db.user.update({ where: { email: 'admin@smartdesk.test' }, data: { role: 'ADMIN' } });
      await db.$disconnect();
    }
  }
}
NODE
}

baseline=$(journey baseline)
echo 'Captured local report responses for four fixture windows.'
export ANALYTICS_EXECUTION_MODE=service
compose up -d --wait gateway
wait_for_gateway
journey outage
echo 'Ticket creation succeeded with Analytics stopped.'
compose up -d --wait analytics-service
journey service
echo 'Both report endpoints matched in service mode with admin authorization.'

export ANALYTICS_EXECUTION_MODE=local
compose up -d --wait gateway
wait_for_gateway
compose stop analytics-service
journey rollback
echo 'Both report endpoints matched after rollback.'
