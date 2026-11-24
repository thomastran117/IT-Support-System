# SD-100 dynamic analysis

## Reproduction

Run from the repository root with Docker Compose, Node.js, and Git.

```sh
SD100=1 SD100_PASSIVE_SCAN=1 sh docker/verify-ticket-service.sh
```

The script uses a disposable Compose project with seeded PostgreSQL, the fake AI
provider, and the production Next.js build. The browser uses loopback origins
for Web Crypto, and a TCP relay forwards its API traffic to the real gateway on
the public network. The six application services listen on private networks.
OpenSearch is real in the search drill. The latency comparison runs with Redis
and OpenSearch disabled and uses the same fake provider in both layouts.

The `microservice-verification` artifact from the frontend workflow includes the
tested revision, test log, request latency JSON, Docker resource snapshots, and
ZAP output. Local runs place those files in `frontend/test-results/sd100/`.
The [Ticket service runbook](../architecture/ticket-service.md) describes the
rollback procedure used by the gate. The [static report](microservice-static-analysis.md)
records the source and dependency scans.

## Measurement method

The pre/post comparison isolates the deployment topology on one application
revision. It uses a gateway with the legacy backend and worker, then the same
gateway with Ticket, Identity, AI, Knowledge, Analytics, and Notifications.
The two databases start from cloned copies of the same seed. Both runs use the
same Postgres container and the same host, with a 200 ms worker poll interval.

The workload carries forward the Teams and Reports requests from the
[Redis evaluation](../redis-evaluation.md) and adds ticket submission. Each
round starts one request per endpoint concurrently. Four warm-up rounds precede
30 measured rounds with 200 ms between rounds. Latency covers the real HTTP
request through JSON response parsing. Docker stats samples the application
containers while the client runs. Reported CPU is expressed as a percentage of
one logical core and the memory figures use Docker's working-set readings.

## Measured comparison

The November 24, 2026 local run measured application revision
`b27b24459abb273d95163a04bccacf002f014c54` with Docker on ARM64, 8 logical CPUs,
and 7.55 GiB. Each seed contained 8 users, 10 tickets, and 5 knowledge articles.
The legacy window was `20:09:43.451Z–20:09:50.126Z`. The isolated window was
`20:10:09.843Z–20:10:16.644Z`. Each window recorded 90 successful requests and
zero HTTP failures.

| Request       | Samples per layout | Legacy p50 / p95 / p99 (ms) | Isolated p50 / p95 / p99 (ms) |
| ------------- | -----------------: | --------------------------: | ----------------------------: |
| Teams         |                 30 |       10.09 / 19.72 / 19.90 |         14.01 / 27.61 / 27.85 |
| Reports       |                 30 |       12.64 / 24.63 / 26.27 |         14.91 / 27.99 / 28.78 |
| Submit ticket |                 30 |       20.40 / 35.67 / 38.09 |         21.96 / 45.89 / 54.30 |

| Layout                            | Docker samples per container | Mean CPU sum | Mean memory sum | PostgreSQL CPU / memory |
| --------------------------------- | ---------------------------: | -----------: | --------------: | ----------------------: |
| Gateway, legacy API, worker       |                            4 |        20.0% |       376.3 MiB |       12.9% / 102.0 MiB |
| Gateway and six isolated services |                            5 |        70.3% |       636.0 MiB |       13.9% / 105.0 MiB |

CPU and memory sums cover the application containers. PostgreSQL is reported
separately. The isolated layout used 259.7 MiB more application memory in this
sample, and ticket submission p95 rose by 10.22 ms. This short, three-request
workload characterizes the local topology. Sustained concurrency and availability
measurements are tracked in [SD-057](https://github.com/thomastran117/IT-Support-System/issues/69).

## Passive scan scope

ZAP's automation plan observes four ordinary unauthenticated responses from
the disposable deployment. It requests the Next.js login, gateway liveness,
Identity's current-user endpoint, and the protected Analytics summary.
It waits for the passive scan queue and emits a JSON report. The authenticated
flows and role denials are exercised by the browser and API suites.
[ZAP Automation Framework](https://www.zaproxy.org/docs/automate/automation-framework/)

ZAP 2.16.1 completed the plan and reported seven instances. Five concerned
application responses. Two reported the scanner version.

| Severity | Observed finding                                                                         | Disposition                                                                             |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Medium   | The frontend login response omitted Content Security Policy and clickjacking protection. | Open. Define frontend response headers and verify the policy with the production build. |
| Low      | The API and frontend responses each flagged a missing `X-Content-Type-Options` header.   | Open. Verify header coverage at the public HTTP boundaries.                             |
| Low      | The frontend login response exposed `X-Powered-By`.                                      | Open. Disable framework identification in the frontend configuration.                   |
| Low      | ZAP reported its own version once per origin.                                            | Scanner maintenance. Refresh the pinned image and rerun the same passive plan.          |

The four-response sample produced zero high-severity alerts. Response header
remediation remains tracked in [SD-066](https://github.com/thomastran117/IT-Support-System/issues/79).
