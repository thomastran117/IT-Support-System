#!/bin/sh
set -eu

unset COMPOSE_FILE COMPOSE_PROFILES
export COMPOSE_DISABLE_ENV_FILE=1
export BACKEND_PORT=127.0.0.1:0 FRONTEND_PORT=127.0.0.1:0
export POSTGRES_USER=smartdesk POSTGRES_PASSWORD=smartdesk POSTGRES_DB=smartdesk
export AI_PROVIDER=none EMAIL_TRANSPORT=none OPENSEARCH_ENABLED=false REDIS_URL=
export WORKER_POLL_INTERVAL_MS=200

project=smartdesk-default-ci-$$
compose() { docker compose -p "$project" "$@"; }
modular() { compose -f docker-compose.modular.yml "$@"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose logs --no-color
    modular logs --no-color backend
  fi
  compose down -v --remove-orphans
  exit "$status"
}
trap cleanup EXIT

probe() {
  layout=$1
  shift
  "$layout" exec -T -e TICKET_ID="${ticket_id:-}" gateway node --input-type=module - "$@" \
    < docker/verify-microservice-http.mjs
}

config_hashes() {
  for service in ticket identity knowledge analytics notifications ai; do
    compose exec -T "$service-service" node -e '
      const { createHash } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      console.log(createHash("sha256").update(readFileSync("/run/smartdesk/config.env")).digest("hex"));
    '
  done
}

compose config --format json | node -e '
  const assert = require("node:assert/strict");
  const { services, networks } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const domains = ["ai", "analytics", "identity", "knowledge", "notifications", "ticket"];
  assert.deepEqual(Object.keys(services).sort(), [
    ...domains.map((domain) => domain + "-service"), "frontend", "gateway", "local-bootstrap", "postgres",
  ].sort());
  assert.deepEqual(Object.keys(services).filter((name) => services[name].ports?.length).sort(), ["frontend", "gateway"]);
  assert.ok(networks.internal.internal && networks.api.internal);
  for (const domain of domains) {
    const service = services[domain + "-service"];
    assert.deepEqual(service.volumes.map(({ source, read_only }) => [source, read_only]), [["local-" + domain + "-config", true]]);
    assert.equal(service.depends_on["local-bootstrap"].condition, "service_completed_successfully");
    assert.ok(!Object.keys(service.environment).some((name) =>
      /DATABASE_URL|PRIVATE_KEY|SERVICE_KEYS|RETRIEVAL_KEYS|CURSOR_SECRET/.test(name)));
  }
  assert.ok(!Object.hasOwn(services.gateway.depends_on, "ai-service"));
'

# First launch with no .env, seed, or provider credentials.
echo 'Verify startup without a .env file'
compose up --build --wait --wait-timeout 180
compose exec -T postgres psql -XAt -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk \
  -c 'SELECT count(*) FROM users' | grep -qx 0
compose run --rm --no-deps local-bootstrap npm run db:seed -- --profile test
ticket_id=$(probe compose compose-startup)
original_hashes=$(config_hashes)

echo 'Verify credentials and ticket data after restarting'
compose down
compose up --wait --wait-timeout 180
test "$(config_hashes)" = "$original_hashes"
probe compose compose-persisted

# Verify the first standalone launch also works on data created by the modular API.
echo 'Verify upgrade with existing modular data'
compose down -v
modular up -d --build gateway
probe modular compose-ready
modular exec -T backend npm run db:seed -- --profile test
ticket_id=$(probe modular compose-create)
modular down
compose up --wait --wait-timeout 180
probe compose compose-persisted
echo 'Default Compose startup, restart, and upgrade passed'
