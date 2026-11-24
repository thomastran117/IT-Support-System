#!/bin/sh
set -eu

unset COMPOSE_PROFILES
export BACKEND_PORT=127.0.0.1:0
export POSTGRES_USER=smartdesk POSTGRES_PASSWORD=smartdesk POSTGRES_DB=smartdesk
export KNOWLEDGE_EXECUTION_MODE=local NOTIFICATIONS_EXECUTION_MODE=local ANALYTICS_EXECUTION_MODE=local
export AI_EXECUTION_MODE=service AI_PROVIDER=fake EMAIL_TRANSPORT=none OPENSEARCH_ENABLED=false
export WORKER_POLL_INTERVAL_MS=200
export KNOWLEDGE_DATABASE_URL=postgres://knowledge_test:knowledge-test-only@postgres:5432/smartdesk
export KNOWLEDGE_KEY_ID=knowledge-test AI_SERVICE_KEY_ID=ai-test KNOWLEDGE_WORKER_KEY_ID=local-ai-test

project=smartdesk-knowledge-ci-$$
compose() { docker compose -f docker-compose.modular.yml -p "$project" --env-file .env.example --profile knowledge --profile services "$@"; }
trap 'compose down -v' EXIT
if docker compose -f docker-compose.modular.yml --env-file .env.example config --services | grep -qx knowledge-service; then
  echo 'Knowledge must require its explicit profile.' >&2
  exit 1
fi

keys=$(node --input-type=module - <<'NODE'
import { generateKeyPairSync } from 'node:crypto';

function generate(kid, service) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicEntry: { kid, service, publicKey } };
}
const knowledge = generate('knowledge-test', 'knowledge');
const ai = generate('ai-test', 'ai');
const worker = generate('local-ai-test', 'ai-local');
const retrieval = { 'knowledge:published-retrieval': 'system' };
process.stdout.write(JSON.stringify({
  knowledge: knowledge.privateKey, ai: ai.privateKey, worker: worker.privateKey,
  identity: [
    { ...knowledge.publicEntry, grants: { 'identity:knowledge-principal': 'user' } },
    { ...ai.publicEntry, grants: Object.fromEntries(['claim', 'inputs', 'complete', 'fail']
      .map((name) => ['ticket:analysis-' + name, 'system'])) },
  ],
  retrieval: [ai, worker].map(({ publicEntry }) => ({ ...publicEntry, grants: retrieval })),
}));
NODE
)
key_field() {
  printf '%s' "$keys" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"))[process.argv[1]];
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1"
}
KNOWLEDGE_PRIVATE_KEY=$(key_field knowledge)
AI_SERVICE_PRIVATE_KEY=$(key_field ai)
KNOWLEDGE_WORKER_PRIVATE_KEY=$(key_field worker)
INTERNAL_SERVICE_KEYS=$(key_field identity)
KNOWLEDGE_RETRIEVAL_KEYS=$(key_field retrieval)
unset keys
export KNOWLEDGE_PRIVATE_KEY AI_SERVICE_PRIVATE_KEY KNOWLEDGE_WORKER_PRIVATE_KEY
export INTERNAL_SERVICE_KEYS KNOWLEDGE_RETRIEVAL_KEYS

compose build backend gateway knowledge-service ai-service worker
compose run --rm --no-deps knowledge-service npm test
compose config --format json | node -e '
  const { services, networks } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const knowledge = services["knowledge-service"];
  const assert = require("node:assert/strict");
  assert.equal((knowledge.ports ?? []).length, 0);
  assert.deepEqual(Object.keys(knowledge.networks).sort(), ["api", "internal"]);
  assert.ok(networks.api.internal && networks.internal.internal);
  assert.ok(!services.gateway.depends_on["knowledge-service"]);
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
compose up -d --wait gateway
wait_for_gateway

psql() { compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk; }
psql < backend/sql/service-access/roles.sql
psql < backend/sql/service-access/enable.sql
psql <<'SQL'
CREATE ROLE knowledge_test LOGIN PASSWORD 'knowledge-test-only';
GRANT smartdesk_knowledge TO knowledge_test WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
SQL
compose exec -T backend npm run db:seed -- --profile test

journey() {
  compose exec -T -e KNOWLEDGE_PHASE="$1" -e KNOWLEDGE_ARTICLE_ID="${article_id:-}" \
    backend node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createPrisma } from '@smartdesk/db';
import { KNOWLEDGE_RETRIEVAL } from '@smartdesk/contracts';

const phase = process.env.KNOWLEDGE_PHASE;
const id = process.env.KNOWLEDGE_ARTICLE_ID;
const adminPath = '/api/admin/knowledge';
const readerPath = '/api/knowledge';
const search = readerPath + '/search?q=cipherwombat';

async function api(path, { method = 'GET', token, body, status = 200, headers } = {}) {
  const response = await fetch('http://gateway:4000' + path, {
    method,
    headers: {
      ...(token && { authorization: 'Bearer ' + token }),
      ...(body && { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, status, phase + ' ' + method + ' ' + path);
  return (await response.json()).data;
}
const access = (name) => api('/api/auth/login', {
  method: 'POST', body: { email: name + '@smartdesk.test', password: 'SmartDesk-Demo-1!' },
}).then(({ accessToken }) => accessToken);
const employee = await access('erin');
if (phase === 'baseline') {
  assert.equal((await api(readerPath + '/search?q=vpn', { token: employee })).total, 1);
}
if (phase === 'prepare') {
  const admin = await access('admin');
  await api(readerPath, { status: 401 });
  await api(adminPath, { token: employee, headers: { 'x-actor-role': 'ADMIN' }, status: 403 });
  const categories = await api(readerPath + '/categories', { token: employee });
  const category = categories.find(({ name }) => name === 'Network/VPN');
  assert.equal(category.description, 'Connectivity and VPN');
  const body = { title: 'Cipherwombat configuration', body: 'Cipherwombat instructions. Contact sample@example.test.', categoryId: category.id };
  const article = await api(adminPath, { method: 'POST', token: admin, body, status: 201 });
  assert.equal(article.isPublished, false);
  const path = adminPath + '/' + article.id;
  await api(readerPath + '/' + article.id, { token: admin, status: 404 });
  assert.equal((await api(search, { token: employee })).total, 0);
  assert.equal((await api(path, { token: admin })).id, article.id);
  await api(path + '/publish', { method: 'POST', token: admin });
  assert.equal((await api(search, { token: employee })).items[0].id, article.id);
  const revised = 'Updated Cipherwombat instructions. Contact sample@example.test.';
  await api(path, { method: 'PATCH', token: admin, body: { body: revised } });
  assert.equal((await api(readerPath + '/' + article.id, { token: employee })).body, revised);
  await api(KNOWLEDGE_RETRIEVAL.path, { method: 'POST', token: admin, body: { terms: ['cipherwombat'] }, status: 404 });
  const privateResponse = await fetch('http://knowledge-api:4040' + KNOWLEDGE_RETRIEVAL.path, {
    method: 'POST', headers: { authorization: 'Bearer ' + admin, 'content-type': 'application/json' },
    body: '{"terms":["cipherwombat"]}', signal: AbortSignal.timeout(5000),
  });
  assert.equal(privateResponse.status, 401);
  await privateResponse.body?.cancel();
  process.stdout.write(article.id);
}
if (phase === 'citation' || phase === 'outage') {
  if (phase === 'outage') await api(search, { token: employee, status: 503 });
  const ticket = await api('/api/tickets', {
    method: 'POST', token: employee, status: 201,
    body: { title: 'Cipherwombat issue', description: 'Cipherwombat needs configuration.' },
  });
  const db = createPrisma(process.env.DATABASE_URL);
  try {
    const deadline = Date.now() + 35_000;
    for (;;) {
      const saved = await db.aiRecommendation.findFirst({
        where: { ticketId: ticket.id },
        select: { articles: { select: { articleId: true } } },
      });
      if (saved) {
        assert.deepEqual(saved.articles.map(({ articleId }) => articleId), phase === 'citation' ? [id] : []);
        break;
      }
      assert.ok(Date.now() < deadline, 'AI did not finish the ' + phase + ' ticket');
      await setTimeout(300);
    }
  } finally {
    await db.$disconnect();
  }
  assert.equal((await api('/api/tickets/' + ticket.id, { token: employee })).status, 'OPEN');
}
if (phase === 'unpublish' || phase === 'rollback') {
  const admin = await access('admin');
  const path = adminPath + '/' + id;
  if (phase === 'unpublish') {
    await api(path + '/unpublish', { method: 'POST', token: admin });
    const db = createPrisma(process.env.DATABASE_URL);
    try {
      assert.equal(await db.recommendationArticle.count({ where: { articleId: id } }), 2);
      const intents = await db.$queryRaw`
        SELECT revision, event_kind AS kind FROM search_index_jobs
        WHERE entity_type = 'KNOWLEDGE_ARTICLE' AND entity_id = ${id}::uuid ORDER BY revision`;
      assert.deepEqual(intents, [
        { revision: 2, kind: 'UPSERT' }, { revision: 3, kind: 'UPSERT' }, { revision: 4, kind: 'DELETE' },
      ]);
    } finally {
      await db.$disconnect();
    }
  }
  assert.equal((await api(path, { token: admin })).isPublished, false);
  await api(readerPath + '/' + id, { token: employee, status: 404 });
  assert.equal((await api(search, { token: employee })).total, 0);
  if (phase === 'rollback') {
    await api(path + '/publish', { method: 'POST', token: admin });
    assert.equal((await api(search, { token: employee })).items[0].id, id);
  }
}
NODE
}

verify_retrieval() {
  compose exec -T -e KNOWLEDGE_ARTICLE_ID="$article_id" -e EXPECT_PUBLISHED="$1" \
    worker node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { KNOWLEDGE_RETRIEVAL, knowledgeRetrievalSchema } from '@smartdesk/contracts';
import { createSystemServiceClient } from '@smartdesk/service-runtime/service-tokens';

const call = await createSystemServiceClient({
  origin: new URL(process.env.KNOWLEDGE_RETRIEVAL_ORIGIN),
  route: KNOWLEDGE_RETRIEVAL, service: 'ai-local', timeoutMs: 1500,
  kid: process.env.KNOWLEDGE_WORKER_KEY_ID, privateKey: process.env.KNOWLEDGE_WORKER_PRIVATE_KEY,
  keySetting: 'KNOWLEDGE_WORKER_PRIVATE_KEY',
});
const result = await call({ terms: ['cipherwombat'] }, knowledgeRetrievalSchema.parse);
assert.ok(result);
if (process.env.EXPECT_PUBLISHED === 'yes') {
  assert.deepEqual(result.articles.map(({ id }) => id), [process.env.KNOWLEDGE_ARTICLE_ID]);
  assert.match(result.articles[0].body, /^Updated Cipherwombat instructions/);
  assert.doesNotMatch(result.articles[0].body, /sample@example.test/);
} else {
  assert.deepEqual(result.articles, []);
}
NODE
}

journey baseline
export KNOWLEDGE_EXECUTION_MODE=service
compose up -d --wait gateway knowledge-service
wait_for_gateway
article_id=$(journey prepare)

compose up -d --wait ai-service
journey citation
compose stop knowledge-service
journey outage
compose stop ai-service
echo 'Independent AI used published sources and completed a ticket without Knowledge.'

export AI_EXECUTION_MODE=local
compose up -d --wait gateway knowledge-service worker
wait_for_gateway
journey citation
verify_retrieval yes
compose stop knowledge-service
journey outage
echo 'Local AI used the same retrieval endpoint and continued during the outage.'

compose up -d --wait knowledge-service
journey unpublish
verify_retrieval no
export KNOWLEDGE_EXECUTION_MODE=local
compose up -d --wait gateway worker
wait_for_gateway
compose stop knowledge-service
journey rollback
echo 'Article search, publication, historical links, index intents, and rollback verified.'
