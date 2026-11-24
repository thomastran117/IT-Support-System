#!/bin/sh
set -eu

unset COMPOSE_PROFILES
export BACKEND_PORT=127.0.0.1:0
export POSTGRES_USER=smartdesk POSTGRES_PASSWORD=smartdesk POSTGRES_DB=smartdesk
export IDENTITY_EXECUTION_MODE=local NOTIFICATIONS_EXECUTION_MODE=service
export AI_EXECUTION_MODE=local AI_PROVIDER=none EMAIL_TRANSPORT=none OPENSEARCH_ENABLED=false
export KNOWLEDGE_EXECUTION_MODE=local ANALYTICS_EXECUTION_MODE=local
export IDENTITY_DATABASE_URL=postgres://identity_test:identity-test-only@postgres:5432/smartdesk
export NOTIFICATIONS_DATABASE_URL=postgres://notification_test:notification-test-only@postgres:5432/smartdesk
export TICKET_IDENTITY_KEY_ID=ticket-fixture NOTIFICATIONS_KEY_ID=notifications-fixture
export JWT_SECRET=identity-ci-continuity-key-for-test-fixtures-only
export IDENTITY_JWT_SECRET="$JWT_SECRET"
export TICKET_SEARCH_CURSOR_SECRET=ticket-ci-cursor-key-for-test-fixtures-only
export REDIS_URL=redis://redis:6379 FRONTEND_ORIGIN=http://localhost:3000 COOKIE_SECURE=false

project=smartdesk-identity-ci-$$
compose() { docker compose -f docker-compose.modular.yml -p "$project" --env-file .env.example --profile cache --profile identity --profile notifications "$@"; }
trap 'compose down -v' EXIT
if docker compose -f docker-compose.modular.yml --env-file .env.example config --services | grep -qx identity-service; then
  echo 'Identity must require its explicit profile.' >&2
  exit 1
fi

keys=$(node --input-type=module - <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
function generate(kid, service, scope) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, entry: { kid, service, publicKey, grants: { [scope]: 'user' } } };
}
const ticket = generate('ticket-fixture', 'ticket', 'identity:ticket-principal');
const inbox = generate('notifications-fixture', 'notifications', 'identity:notification-recipient');
process.stdout.write(JSON.stringify({
  ticket: ticket.privateKey, notifications: inbox.privateKey, registry: [ticket.entry, inbox.entry],
}));
NODE
)
key_field() {
  printf '%s' "$keys" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"))[process.argv[1]];
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1"
}
TICKET_IDENTITY_PRIVATE_KEY=$(key_field ticket)
NOTIFICATIONS_PRIVATE_KEY=$(key_field notifications)
INTERNAL_SERVICE_KEYS=$(key_field registry)
unset keys
export TICKET_IDENTITY_PRIVATE_KEY NOTIFICATIONS_PRIVATE_KEY INTERNAL_SERVICE_KEYS

compose build backend gateway identity-service notifications-service
compose run --rm --no-deps identity-service npm test
compose config --format json | node -e '
  const assert = require("node:assert/strict");
  const { services, networks } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const identity = services["identity-service"];
  assert.equal((identity.ports ?? []).length, 0);
  assert.deepEqual(Object.keys(identity.networks).sort(), ["api", "internal"]);
  assert.ok(networks.api.internal && networks.internal.internal);
  assert.ok(!services.gateway.depends_on["identity-service"]);
'

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
compose up -d --wait gateway redis
wait_for_gateway
psql() { compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk; }
psql < backend/sql/service-access/roles.sql
psql < backend/sql/service-access/enable.sql
psql <<'SQL'
CREATE ROLE identity_test LOGIN PASSWORD 'identity-test-only';
GRANT smartdesk_identity TO identity_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
CREATE ROLE notification_test LOGIN PASSWORD 'notification-test-only';
GRANT smartdesk_notifications TO notification_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
SQL
compose exec -T backend npm run db:seed -- --profile test
compose up -d --wait notifications-service

journey() {
  compose exec -T -e IDENTITY_PHASE="$1" -e IDENTITY_BASELINE="${baseline:-}" \
    -e IDENTITY_ROLLBACK="${rollback_state:-}" backend node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { createPrisma } from '@smartdesk/db';
import { NOTIFICATION_IDENTITY, TICKET_IDENTITY } from '@smartdesk/contracts';

const phase = process.env.IDENTITY_PHASE;
const origin = 'http://localhost:3000';
const seededPassword = 'SmartDesk-Demo-1!';
const users = '/api/admin/users';
const inbox = '/api/notifications';
const me = '/api/auth/me';
async function call(path, { method = 'GET', token, body, headers, cookie } = {}) {
  return fetch('http://gateway:4000' + path, {
    method, signal: AbortSignal.timeout(15_000),
    headers: {
      ...(token && { authorization: 'Bearer ' + token }),
      ...(body && { 'content-type': 'application/json' }),
      ...(cookie && { cookie }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
}
async function api(path, { status = 200, ...options } = {}) {
  const response = await call(path, options);
  assert.equal(response.status, status, phase + ' ' + (options.method ?? 'GET') + ' ' + path);
  const data = (await response.json()).data;
  return { data, headers: response.headers };
}
const get = (path, token, status) => api(path, { token, status }).then(({ data }) => data);
const post = (path, token, body, status) => api(path, { method: 'POST', token, body, status }).then(({ data }) => data);
function session({ data, headers }) {
  const [cookie] = headers.getSetCookie();
  assert.match(cookie, /^sd_refresh=/);
  assert.match(cookie, /Path=\/api\/auth/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal(headers.get('cache-control'), 'no-store');
  return { token: data.accessToken, id: data.user.id, role: data.user.role, cookie: cookie.split(';')[0] };
}
const login = (name, password = seededPassword, status = 200) => api('/api/auth/login', {
  method: 'POST', body: { email: name + '@smartdesk.test', password }, status,
}).then((response) => status === 200 ? session(response) : response);
const sessionAction = (name, cookie, status = 200, source = origin) => api('/api/auth/' + name, {
  method: 'POST', cookie, headers: { origin: source }, status,
});
const meWith = (active) => get(me, active.token);
const assertCleared = ({ headers }) => assert.match(headers.getSetCookie()[0], /Max-Age=0|Expires=Thu, 01 Jan 1970/i);

if (phase === 'baseline') {
  const employee = await login('erin');
  await get(inbox, employee.token);
  process.stdout.write(JSON.stringify(employee));
} else {
  const employee = JSON.parse(process.env.IDENTITY_BASELINE);
  if (phase === 'outage') {
    await get(me, employee.token, 503);
    await get('/api/tickets', employee.token, 503);
    await post('/api/tickets', employee.token, { title: 'Should be blocked', description: 'Identity is unavailable.' }, 503);
    await get(inbox, employee.token, 503);
    await get('/api/tickets', undefined, 401);
  }
  if (phase === 'service') {
    assert.equal((await meWith(employee)).id, employee.id);
    await get('/api/tickets', employee.token);
    await get(inbox, employee.token);
    await api(users, { token: employee.token, status: 403, headers: { 'x-actor-role': 'ADMIN' } });
    await sessionAction('refresh', employee.cookie, 403, 'http://untrusted.invalid');
    const refreshed = session(await sessionAction('refresh', employee.cookie));
    assert.equal(refreshed.id, employee.id);
    assertCleared(await sessionAction('logout', refreshed.cookie));
    assertCleared(await sessionAction('logout'));

    const admin = await login('admin');
    const technician = await login('tara');
    await login('ivan.inactive', seededPassword, 401);
    const teams = await get('/api/teams?mine=true', technician.token);
    assert.deepEqual(teams.map(({ name }) => name), ['Network & Access']);
    await post('/api/admin/teams/' + teams[0].id + '/deactivate', admin.token);
    assert.deepEqual(await get('/api/teams?mine=true', technician.token), []);
    await post('/api/admin/teams/' + teams[0].id + '/activate', admin.token);

    await get(TICKET_IDENTITY.path, employee.token, 404);
    const key = await importPKCS8(process.env.TICKET_IDENTITY_PRIVATE_KEY, 'ES256');
    const delegated = await new SignJWT({
      scope: TICKET_IDENTITY.scope,
      actor: { kind: 'user', tokenHash: createHash('sha256').update(employee.token).digest('base64url') },
    }).setProtectedHeader({ alg: 'ES256', typ: 'smartdesk-service+jwt', kid: process.env.TICKET_IDENTITY_KEY_ID })
      .setIssuer('smartdesk-internal').setAudience(TICKET_IDENTITY.audience).setSubject('ticket')
      .setIssuedAt().setExpirationTime('30s').sign(key);
    const privateRead = (path, token, userToken) => fetch('http://identity-api:4050' + path, {
      signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer ' + token, 'x-smartdesk-internal-user-token': userToken },
    });
    const verified = await privateRead(TICKET_IDENTITY.path, delegated, employee.token);
    assert.equal(verified.status, 200);
    const state = await verified.json();
    assert.deepEqual(Object.keys(state).sort(), ['id', 'tokenVersion']);
    assert.equal(state.id, employee.id);
    for (const [path, token, userToken, status] of [
      [TICKET_IDENTITY.path, delegated, admin.token, 401],
      [TICKET_IDENTITY.path, employee.token, employee.token, 401],
      [NOTIFICATION_IDENTITY.path, delegated, employee.token, 403],
    ]) {
      const denied = await privateRead(path, token, userToken);
      assert.equal(denied.status, status);
      await denied.body?.cancel();
    }

    const created = await post(users, admin.token, {
      email: 'identity-fixture@smartdesk.test', displayName: 'Identity Fixture', role: 'EMPLOYEE',
    }, 201);
    const original = await login('identity-fixture', created.temporaryPassword);
    assert.equal(original.id, created.user.id);
    const reset = await post(users + '/' + original.id + '/reset-password', admin.token);
    await get(me, original.token, 401);
    assertCleared(await sessionAction('refresh', original.cookie, 401));
    await login('identity-fixture', created.temporaryPassword, 401);
    const rotation = await login('identity-fixture', reset.temporaryPassword);
    await api(users + '/' + original.id + '/role', {
      method: 'PATCH', token: admin.token, body: { role: 'TECHNICIAN' },
    });
    await get('/api/tickets', rotation.token, 401);
    const survivor = await login('identity-fixture', reset.temporaryPassword);
    assert.equal(survivor.role, 'TECHNICIAN');

    await post(users + '/' + employee.id + '/deactivate', admin.token);
    await get('/api/tickets', employee.token, 401);
    await get(inbox, employee.token, 401);
    assertCleared(await sessionAction('refresh', employee.cookie, 401));
    await post(users + '/' + admin.id + '/deactivate', admin.token, undefined, 403);
    const audit = await get('/api/admin/audit-log', admin.token);
    for (const action of ['USER_CREATED', 'PASSWORD_RESET', 'ROLE_CHANGED', 'USER_DEACTIVATED']) {
      assert.ok(audit.some((entry) => entry.action === action));
    }

    const second = await post(users, admin.token, {
      email: 'identity-admin@smartdesk.test', displayName: 'Second Admin', role: 'ADMIN',
    }, 201);
    const other = await login('identity-admin', second.temporaryPassword);
    const concurrent = await Promise.all([
      call(users + '/' + other.id + '/deactivate', { method: 'POST', token: admin.token }),
      call(users + '/' + admin.id + '/deactivate', { method: 'POST', token: other.token }),
    ]);
    const statuses = concurrent.map(({ status }) => status).sort();
    assert.equal(statuses[0], 200);
    assert.ok([401, 409].includes(statuses[1]));
    await Promise.all(concurrent.map(({ body }) => body?.cancel()));
    const db = createPrisma(process.env.DATABASE_URL);
    try {
      assert.equal(await db.user.count({ where: { role: 'ADMIN', isActive: true } }), 1);
    } finally {
      await db.$disconnect();
    }
    let limited = false;
    for (let index = 1; index <= 11; index++) {
      const response = await call('/api/auth/login', {
        method: 'POST', body: { email: 'unknown@smartdesk.test', password: seededPassword },
        headers: { 'x-forwarded-for': '198.51.100.' + index },
      });
      await response.body?.cancel();
      if (response.status === 429) {
        limited = true;
        break;
      }
      assert.equal(response.status, 401);
    }
    assert.ok(limited, 'Spoofed forwarding headers bypassed the login limit');
    process.stdout.write(JSON.stringify(survivor));
  }
  if (phase === 'rollback') {
    const active = JSON.parse(process.env.IDENTITY_ROLLBACK);
    assert.equal((await meWith(active)).role, 'TECHNICIAN');
    assert.equal(session(await sessionAction('refresh', active.cookie)).id, active.id);
    await get('/api/tickets', active.token);
    await get(inbox, active.token);
    await get('/api/tickets', employee.token, 401);
  }
}
NODE
}

baseline=$(journey baseline)
export IDENTITY_EXECUTION_MODE=service JWT_SECRET=ticket-fixture-does-not-sign-browser-tokens
compose up -d --wait gateway notifications-service
wait_for_gateway
journey outage
echo 'Identity outage denied protected requests through Ticket and Notifications.'
compose up -d --wait identity-service
rollback_state=$(journey service)
echo 'Identity preserved sessions, revocation, scoped lookups, membership, and the last admin.'

export IDENTITY_EXECUTION_MODE=local
export JWT_SECRET="$IDENTITY_JWT_SECRET"
compose up -d --wait gateway notifications-service
wait_for_gateway
compose stop identity-service
journey rollback
echo 'Rollback preserved service-issued sessions and account changes.'
