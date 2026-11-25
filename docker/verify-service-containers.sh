#!/bin/sh
set -eu

unset COMPOSE_PROFILES
export BACKEND_PORT=127.0.0.1:0
export AI_SERVICE_TICKET_ORIGIN=http://backend-api:4000
export AI_SERVICE_READY_TIMEOUT_MS=1500
export AI_PROVIDER=none
export AI_EXECUTION_MODE=local

project=smartdesk-service-containers-ci-$$
compose() { docker compose -f docker-compose.modular.yml -p "$project" --env-file .env.example --profile services "$@"; }
cleanup() { compose down -v; }
trap cleanup EXIT

if docker compose -f docker-compose.modular.yml --env-file .env.example config --services | grep -qx ai-service; then
  echo 'The AI service must require the services profile.' >&2
  exit 1
fi

compose config --format json | node -e '
  const assert = require("node:assert/strict");
  const config = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const services = Object.entries(config.services);
  const names = (predicate) => services.filter(([, service]) => predicate(service)).map(([name]) => name).sort();
  const ai = config.services["ai-service"];
  assert.deepEqual(names((s) => s.ports?.length), ["frontend", "gateway"]);
  assert.deepEqual(Object.keys(ai.networks).sort(), ["ai-egress", "api"]);
  assert.equal(config.networks.api.internal, true);
  assert.deepEqual(names((s) => Object.hasOwn(s.networks ?? {}, "api")), ["ai-service", "backend", "gateway"]);
  assert.deepEqual(names((s) => Object.hasOwn(s.networks ?? {}, "ai-egress")), ["ai-service"]);
  assert.equal(Object.hasOwn(ai.environment, "DATABASE_URL"), false);
'

check_health() {
  compose exec -T ai-service node --input-type=module -e '
    import assert from "node:assert/strict";
    import { setTimeout } from "node:timers/promises";
    const expected = process.argv[1];
    const probe = (path) => fetch("http://127.0.0.1:4010/health/" + path, {
      signal: AbortSignal.timeout(6000),
    });
    const live = await probe("live");
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });
    const deadline = Date.now() + 30_000;
    let ready = await probe("ready");
    while (expected === "ok" && ready.status === 503 && Date.now() < deadline) {
      await ready.body?.cancel();
      await setTimeout(1000);
      ready = await probe("ready");
    }
    assert.equal(ready.status, expected === "ok" ? 200 : 503);
    assert.deepEqual(await ready.json(), { status: expected, checks: { ticketApi: expected } });
  ' "$1"
}

compose build ai-service
compose run --rm --no-deps ai-service npm test
compose up --build --wait --wait-timeout 90 ai-service gateway
check_health ok
compose restart ai-service
compose up --wait --wait-timeout 60 ai-service
check_health ok
compose stop backend
check_health unavailable
compose up --wait --wait-timeout 90 ai-service
check_health ok
compose stop ai-service
compose exec -T gateway node -e '
  fetch("http://127.0.0.1:4000/health/ready", { signal: AbortSignal.timeout(5000) })
    .then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1));
'

# Start Ticket without the independent runner to check durable enqueue and legacy worker isolation.
keys=$(compose run --rm --no-deps -T ai-service node --input-type=module - <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const grants = Object.fromEntries(
  ['claim', 'inputs', 'complete', 'fail'].map((op) => ['ticket:analysis-' + op, 'system']),
);
process.stdout.write(JSON.stringify({
  privateKey,
  registry: [{ kid: 'compose-ai-test', service: 'ai', publicKey, grants }],
}));
NODE
)
AI_SERVICE_PRIVATE_KEY=$(printf '%s' "$keys" | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).privateKey')
INTERNAL_SERVICE_KEYS=$(printf '%s' "$keys" | node -pe 'JSON.stringify(JSON.parse(require("node:fs").readFileSync(0, "utf8")).registry)')
unset keys
export AI_SERVICE_PRIVATE_KEY INTERNAL_SERVICE_KEYS
export AI_SERVICE_KEY_ID=compose-ai-test
export AI_EXECUTION_MODE=service
export AI_PROVIDER=fake
export WORKER_POLL_INTERVAL_MS=250

compose up --wait --wait-timeout 90 gateway worker
compose exec -T backend npm run db:seed -- --profile test
ticket_id=$(compose exec -T backend node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createPrisma } from '@smartdesk/db';
const call = (path, options = {}) => fetch('http://gateway:4000' + path, {
  ...options, signal: AbortSignal.timeout(5000),
});
const deadline = Date.now() + 30_000;
while (true) {
  const ready = await call('/health/ready');
  await ready.body?.cancel();
  if (ready.ok) break;
  assert.ok(Date.now() < deadline, 'Ticket did not become ready');
  await setTimeout(500);
}
const privateRoute = await call('/internal/tickets/analysis-jobs/claim', { method: 'POST' });
assert.equal(privateRoute.status, 404);
await privateRoute.body?.cancel();
const login = await call('/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'erin@smartdesk.test', password: 'SmartDesk-Demo-1!' }),
});
assert.equal(login.status, 200);
const { data: { accessToken } } = await login.json();
const submitted = await call('/api/tickets', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },
  body: JSON.stringify({ title: 'VPN disconnects', description: 'Cannot reconnect the VPN client.' }),
});
assert.equal(submitted.status, 201);
const { data: ticket } = await submitted.json();
const db = createPrisma(process.env.DATABASE_URL);
try {
  await setTimeout(750);
  const job = await db.aiAnalysisJob.findFirstOrThrow({ where: { ticketId: ticket.id } });
  assert.equal(job.state, 'QUEUED');
  assert.equal(job.attempts, 0);
  process.stdout.write(ticket.id);
} finally {
  await db.$disconnect();
}
NODE
)

check_recommendation() {
  compose exec -T -e SD093_TICKET_ID="$ticket_id" backend node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createPrisma } from '@smartdesk/db';
const db = createPrisma(process.env.DATABASE_URL);
const ticketId = process.env.SD093_TICKET_ID;
try {
  const deadline = Date.now() + 30_000;
  while (true) {
    const job = await db.aiAnalysisJob.findFirstOrThrow({ where: { ticketId } });
    if (job.state === 'COMPLETED') break;
    assert.notEqual(job.state, 'FAILED', 'Analysis failed with ' + job.errorKind);
    assert.ok(Date.now() < deadline, 'Independent AI service did not finish');
    await setTimeout(500);
  }
  const recommendations = await db.aiRecommendation.findMany({ where: { ticketId } });
  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0].reviewStatus, 'PENDING');
  const ticket = await db.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.status, 'OPEN');
  assert.equal(ticket.assignedTeamId, null);
  assert.equal(ticket.categoryId, null);
  assert.equal(ticket.priority, 'UNSET');
  const delivered = await db.serviceOutboxEvent.count({
    where: { aggregateId: ticketId, type: 'recommendation.ready' },
  });
  assert.equal(delivered, 1);
} finally {
  await db.$disconnect();
}
NODE
}

compose up --wait --wait-timeout 90 ai-service
check_recommendation
compose restart ai-service
compose up --wait --wait-timeout 60 ai-service
check_recommendation
