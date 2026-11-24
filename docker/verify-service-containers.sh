#!/bin/sh
set -eu

unset COMPOSE_PROFILES
export BACKEND_PORT=127.0.0.1:0
export AI_SERVICE_TICKET_ORIGIN=http://gateway:4000
export AI_SERVICE_READY_TIMEOUT_MS=1500
export AI_PROVIDER=none

project=smartdesk-service-containers-ci-$$
compose() { docker compose -p "$project" --env-file .env.example --profile services "$@"; }
cleanup() { compose down -v; }
trap cleanup EXIT

if docker compose --env-file .env.example config --services | grep -qx ai-service; then
  echo 'The AI service must require the services profile.' >&2
  exit 1
fi

compose config --format json | jq -e '
  (.services | to_entries | map(select((.value.ports // []) | length > 0) | .key) | sort == ["frontend", "gateway"]) and
  (.services["ai-service"].networks | keys == ["service-health"]) and
  (.networks["service-health"].internal == true) and
  (.services | to_entries | map(select(.value.networks // {} | has("service-health")) | .key) | sort == ["ai-service", "gateway"])
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
compose up --build --wait --wait-timeout 90 ai-service
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
