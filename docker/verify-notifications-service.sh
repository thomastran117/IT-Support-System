#!/bin/sh
set -eu

unset COMPOSE_PROFILES
export BACKEND_PORT=127.0.0.1:0
export NOTIFICATIONS_EXECUTION_MODE=service WORKER_POLL_INTERVAL_MS=200 EMAIL_TRANSPORT=none AI_PROVIDER=none
export POSTGRES_USER=smartdesk POSTGRES_PASSWORD=smartdesk POSTGRES_DB=smartdesk
export NOTIFICATIONS_DATABASE_URL=postgres://notification_test:notification-test-only@postgres:5432/smartdesk
export NOTIFICATIONS_KEY_ID=notification-test NOTIFICATIONS_IDENTITY_ORIGIN=http://backend-api:4000

project=smartdesk-notifications-ci-$$
compose() { docker compose -p "$project" --env-file .env.example --profile notifications "$@"; }
trap 'compose down -v' EXIT

if docker compose --env-file .env.example config --services | grep -qx notifications-service; then
  echo 'The Notifications service must require its explicit profile.' >&2
  exit 1
fi

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
    kid: 'notification-test', service: 'notifications', publicKey,
    grants: { 'identity:notification-recipient': 'user' },
  }],
}));
NODE
)
NOTIFICATIONS_PRIVATE_KEY=$(printf '%s' "$keys" | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).privateKey')
INTERNAL_SERVICE_KEYS=$(printf '%s' "$keys" | node -pe 'JSON.stringify(JSON.parse(require("node:fs").readFileSync(0, "utf8")).registry)')
unset keys
export NOTIFICATIONS_PRIVATE_KEY INTERNAL_SERVICE_KEYS

compose build backend gateway notifications-service
compose run --rm --no-deps notifications-service npm test
compose up -d --wait gateway
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
wait_for_gateway

psql() { compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk; }
psql < backend/sql/service-access/roles.sql
psql < backend/sql/service-access/enable.sql
psql <<'SQL'
CREATE ROLE notification_test LOGIN PASSWORD 'notification-test-only';
GRANT smartdesk_notifications TO notification_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
SQL
compose exec -T backend npm run db:seed -- --profile test

journey() {
  compose exec -T -e NOTIFICATION_PHASE="$1" -e NOTIFICATION_TICKET_ID="${ticket_id:-}" \
    -e NOTIFICATION_READ_STATE="${read_state:-}" backend node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createPrisma } from '@smartdesk/db';
const call = (path, method = 'GET', token, body, extraHeaders = {}) => fetch('http://gateway:4000' + path, {
  method, signal: AbortSignal.timeout(8000),
  headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...extraHeaders,
    ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function api(path, method, token, body, status = 200) {
  const res = await call(path, method, token, body);
  assert.equal(res.status, status, method + ' ' + path);
  return (await res.json()).data;
}
async function access(name) {
  return (await api('/api/auth/login', 'POST', undefined, {
    email: name + '@smartdesk.test', password: 'SmartDesk-Demo-1!',
  })).accessToken;
}
const erin = await access('erin');
const inbox = '/api/notifications';
if (process.env.NOTIFICATION_PHASE === 'queue') {
  const admin = await access('admin');
  const ticket = await api('/api/tickets', 'POST', erin, {
    title: 'VPN disconnects', description: 'The VPN drops every hour.',
  }, 201);
  const path = '/api/tickets/' + ticket.id;
  const db = createPrisma(process.env.DATABASE_URL);
  try {
    const team = await db.supportTeam.findFirstOrThrow({ where: { name: 'Network & Access' } });
    const category = await db.ticketCategory.findFirstOrThrow({ where: { name: 'Network/VPN' } });
    const assignee = await db.user.findUniqueOrThrow({ where: { email: 'tara@smartdesk.test' } });
    const routed = await api(path + '/routing', 'POST', admin, {
      teamId: team.id, categoryId: category.id, assigneeId: assignee.id, priority: 'MEDIUM',
      expectedVersion: ticket.version,
    });
    const inProgress = await api(path + '/transitions', 'POST', admin, {
      to: 'IN_PROGRESS', expectedVersion: routed.version,
    });
    await api(path + '/comments', 'POST', admin, { body: 'Private service note', isInternal: true }, 201);
    await api(path + '/comments', 'POST', admin, { body: 'Public update' }, 201);
    const resolved = await api(path + '/transitions', 'POST', admin, {
      to: 'RESOLVED', expectedVersion: inProgress.version,
      resolutionSummary: 'Replaced the VPN configuration.',
    });
    assert.equal(resolved.status, 'RESOLVED');
    await api(inbox, 'GET', erin, undefined, 503);
    assert.equal(await db.notification.count({ where: { ticketId: ticket.id } }), 0);
    process.stdout.write(ticket.id);
  } finally {
    await db.$disconnect();
  }
} else {
  const target = process.env.NOTIFICATION_TICKET_ID;
  const items = async (token) => (await api(inbox + '?limit=50', 'GET', token)).items
    .filter((notice) => notice.ticketId === target);
  const deadline = Date.now() + 30_000;
  let notices = await items(erin);
  while (notices.length < 5) {
    assert.ok(Date.now() < deadline, 'Notifications did not drain the backlog');
    await setTimeout(300);
    notices = await items(erin);
  }
  assert.deepEqual(notices.map((notice) => notice.type).sort(), [
    'TECHNICIAN_REPLY', 'TICKET_ASSIGNED', 'TICKET_RESOLVED',
    'TICKET_STATUS_CHANGED', 'TICKET_STATUS_CHANGED',
  ]);
  if (process.env.NOTIFICATION_READ_STATE) {
    const saved = JSON.parse(process.env.NOTIFICATION_READ_STATE);
    assert.equal(notices.find((notice) => notice.id === saved.id)?.readAt, saved.readAt);
  } else {
    const omar = await access('omar');
    const notice = notices.find((entry) => entry.type === 'TICKET_RESOLVED');
    assert.equal(notice.readAt, null);
    assert.equal((await items(omar)).length, 0);
    const forged = await call(inbox + '/' + notice.id + '/read', 'PATCH', omar, undefined, {
      'x-user-id': 'forged-recipient', 'x-actor-role': 'ADMIN',
    });
    assert.equal(forged.status, 404);
    await forged.body?.cancel();
    await api(inbox, 'GET', undefined, undefined, 401);
    await api('/internal/identity/notification-recipient', 'GET', erin, undefined, 404);
    await api(inbox + '/' + notice.id + '/read', 'PATCH', erin);
    const saved = (await items(erin)).find((entry) => entry.id === notice.id);
    assert.ok(saved.readAt);
    process.stdout.write(JSON.stringify({ id: saved.id, readAt: saved.readAt }));
  }
}
NODE
}

ticket_id=$(journey queue)
compose up -d --wait notifications-service
read_state=$(journey verify)
compose restart notifications-service
compose up -d --wait notifications-service
journey verify

compose stop notifications-service
export NOTIFICATIONS_EXECUTION_MODE=local
compose up -d --wait gateway
wait_for_gateway
journey verify
