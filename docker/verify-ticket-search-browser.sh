#!/bin/sh
set -eu

image=$1
project=smartdesk-ticket-search-e2e
export POSTGRES_DB=smartdesk_search_e2e_test
export BACKEND_PORT=127.0.0.1:4400
export FRONTEND_ORIGIN=http://127.0.0.1:3100
export OPENSEARCH_ENABLED=true
export OPENSEARCH_URL=http://opensearch:9200/
export COOKIE_SECURE=false

compose() { docker compose -p "$project" --profile search "$@"; }
cleanup() { compose down -v; }
trap cleanup EXIT

compose up --wait --wait-timeout 180 postgres opensearch
compose build backend gateway
compose run --rm --no-deps backend sh -c 'npm run migrate && ./node_modules/.bin/tsx test/fixtures/seedTicketSearchBrowser.ts && npm run search:backfill -- --version 1'
compose up -d gateway
curl --fail --silent --show-error --retry 20 --retry-delay 1 --retry-all-errors --max-time 3 http://127.0.0.1:4400/health/ready

# Readiness covers the first authenticated searches on the newly backfilled index.
api=http://127.0.0.1:4400/api
token=$(curl --fail --silent --show-error "$api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $FRONTEND_ORIGIN" \
  --data '{"email":"erin@smartdesk.test","password":"SmartDesk-Demo-1!"}' | jq -er '.data.accessToken')
for query in browserdiags vnp monitor; do
  printf 'header = "Authorization: Bearer %s"\n' "$token" | \
    curl --config - --fail --silent --show-error --retry 5 --retry-delay 2 \
      --max-time 5 --get --data-urlencode "q=$query" "$api/tickets/search" >/dev/null
done

browser() {
  docker run --rm --network host -e CI=true -e NEXT_TELEMETRY_DISABLED=1 \
    -e NEXT_PUBLIC_API_URL=http://127.0.0.1:4400 -e E2E_TICKET_SEARCH="$1" \
    -v "$PWD/frontend/test-results:/app/frontend/test-results" \
    -v "$PWD/frontend/playwright-report:/app/frontend/playwright-report" \
    -w /app/frontend "$image" npm run test:e2e -- e2e/ticketSearch.spec.ts --workers=2
}

browser enabled
compose stop opensearch
browser unavailable
