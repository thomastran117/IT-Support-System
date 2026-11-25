#!/bin/sh
set -eu

project=smartdesk-static-ci-$$
evidence=test-results/sd100
mkdir -p "$evidence"
compose() {
  docker compose -p "$project" -f docker-compose.modular.yml -f docker/compose.microservice-static.yml --profile microservice-static "$@"
}
trap 'compose down' EXIT
git rev-parse HEAD > "$evidence/static-revision.txt"
compose run --rm --no-deps microservice-semgrep semgrep scan \
  --metrics=off --disable-version-check --config docker/sd100-semgrep.yml --json \
  frontend/src backend/src backend/gateway/src backend/services packages Dockerfile.dev \
  docker-compose.yml docker-compose.modular.yml docker .github/workflows > "$evidence/semgrep.json"
compose run --rm --no-deps microservice-audit node docker/audit-microservice-deps.mjs \
  > "$evidence/npm-audit.json"
# Report-only like the other scans: findings are recorded for review, not treated as failures.
compose run --rm --no-deps microservice-gitleaks git /src --redact --no-banner \
  --report-format json --report-path - --exit-code 0 > "$evidence/gitleaks.json"
