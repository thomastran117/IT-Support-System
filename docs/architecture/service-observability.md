# Cross-service observability

The Gateway and each HTTP service emit JSON to standard output. Use `LOG_LEVEL=info`
to retain successful requests alongside errors. The standard Compose logging driver
is enough to inspect or aggregate these events.

## Correlation

- The gateway preserves a nonempty `X-Request-Id` or generates a UUID. It forwards
  the ID to the service and returns it in the response
  header, including gateway-generated errors. Services use the same rule for direct calls
  and forward the ID on delegated Identity requests.
- Hash the response header with SHA-256 and search for the hex digest in `correlationId`.
  Use `ticketId` from `ticket_created` to follow the same ticket across separate requests.
- A Ticket `analysis_claimed` event relates `originCorrelationId` from the durable job
  to its `jobId` and `analysisCorrelationId`. The latter is the hash of the job request
  UUID used on the AI worker's Ticket and Knowledge calls. With older jobs, the job
  request UUID supplies the fallback when no origin is stored.
- A `recommendation_reviewed` event identifies the ticket, recommendation, and review
  request hash. When the review routes the ticket, the Notifications `outbox_delivery`
  event for `ticket.routed` carries that review hash, the ticket ID, and the durable
  event ID. Use the same event ID to follow retries.

Logs record registered route templates, status codes, coarse outcomes, and explicit
identifiers. Request and response bodies, authorization headers, cookies, query strings,
raw request IDs, and exception objects stay outside the log records.

## Metrics and readiness

| Event                | Group by                                  | Measure                                                                                      |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `http_request`       | Service, method, route template, outcome  | Completions, 4xx and 5xx counts, and `durationMs` from HTTP receipt to response completion   |
| `dependency_failure` | Reporting service, dependency, error kind | Failed calls and elapsed time to failure                                                     |
| `analysis_job`       | Service, state, error kind                | AI attempt durations from processing start through persistence or failure, plus queue errors |
| `outbox_delivery`    | Service, event type, state                | Delivery attempt durations after claim, including retries and terminal failures              |

Keep ticket, request, job, recommendation, and event IDs as search fields. Grouping
metrics by those IDs produces one series per transaction. Use the completed request
count in the same time window as the denominator for 4xx and 5xx rates. Compute
latency percentiles over request durations within each group.

Each service serves `/health/live` and `/health/ready`. The gateway forwards its
public health routes to Ticket in isolated mode and to the backend in legacy mode.
Ticket checks PostgreSQL and reports optional Redis state. Identity, Knowledge,
Analytics, and Notifications check their scoped database access. AI checks Ticket
readiness. Use the private Compose network for individual probes. A stopped Ticket
service appears as a gateway dependency failure and as an AI readiness failure.

## Reproduce the baseline

Run `sh docker/verify-ticket-service.sh` from the repository root. It starts a
disposable isolated Compose deployment with seeded PostgreSQL, the fake AI provider,
Redis and OpenSearch disabled, and a 200 ms worker poll interval. It submits and reviews
a synthetic ticket, verifies its routing notification, and stops Ticket to exercise
the outage while Identity stays available. The script verifies the trace and privacy
fixtures before printing the UTC window, counts, and nearest-rank p50 and p95 in
milliseconds. Its window starts after the gateway becomes ready and ends after the
outage probes. The HTTP summary excludes health probes except for AI and omits empty
AI queue polls. Job and delivery summaries include completed attempts in the window.

## Measured baseline

The local Compose run on November 24, 2026 measured a 21.201-second window from
`19:32:39.040Z` to `19:33:00.241Z`. It included the manual workflow, the AI-assisted
workflow, and the planned outages.

| Sample                            | Count | 4xx | 5xx | p50 (ms) | p95 (ms) |
| --------------------------------- | ----: | --: | --: | -------: | -------: |
| Gateway HTTP                      |    48 |   5 |   2 |    19.65 |   156.52 |
| Ticket HTTP                       |    42 |   9 |   0 |    12.59 |    49.34 |
| Identity HTTP                     |    46 |   1 |   0 |     2.68 |    36.63 |
| Knowledge HTTP                    |     3 |   0 |   0 |    42.52 |    70.64 |
| Analytics HTTP                    |     1 |   0 |   0 |   112.94 |   112.94 |
| Notifications HTTP                |     4 |   0 |   0 |    10.25 |    63.58 |
| AI readiness                      |     4 |   0 |   2 |     4.37 | 1,500.72 |
| Completed AI attempts             |     2 |   — |   — |    38.37 |   127.29 |
| Completed notification deliveries |     7 |   — |   — |     5.18 |    51.66 |

The gateway's two 503s came from the Notifications and Ticket outages. The AI
readiness p95 includes its 1.5-second Ticket probe timeout. These are timings
from a small synthetic workload using the fake provider.

The script finishes by verifying the [legacy Compose rollback](ticket-service.md)
against the same database. Both deployment modes emit the same HTTP log format.
