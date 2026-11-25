# Dynamic analysis report (Deliverable 2)

This is the final dynamic analysis of SmartDesk's release candidate. It covers the running
system:

- browser journeys through the gateway to the services and PostgreSQL
- authorization at runtime
- outages, recovery and rollback
- data integrity across failures
- response headers, from a passive ZAP scan
- latency under 100 concurrent users

Source and dependency analysis is in the separate
[static analysis report](microservice-static-analysis.md).

## Tested revision and environment

| Item            | Value                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source revision | `e67f9da4256ce57a3ddbdec35d0bc87c4f8d0ec6`, the head of the E10 change stack ([#209](https://github.com/thomastran117/IT-Support-System/pull/209)–[#215](https://github.com/thomastran117/IT-Support-System/pull/215)). CI ran it as merge ref `b4bb2fb5a39a0f4d08420842cc028cdc3e41a443` |
| Integrated gate | [frontend run 45688894263](https://github.com/thomastran117/IT-Support-System/actions/runs/45688894263), job _Isolated browser, outages, and rollback_, artifact `microservice-verification`                                                                                              |
| Load benchmark  | [performance run 45545324951](https://github.com/thomastran117/IT-Support-System/actions/runs/45545324951), artifact `performance-benchmark`. Revision `1a97811` ([#214](https://github.com/thomastran117/IT-Support-System/pull/214)); the code under load is unchanged in `e67f9da`     |
| Host            | GitHub-hosted `ubuntu-latest`: x86_64, 4 logical CPUs, 15.6 GiB, Docker Compose                                                                                                                                                                                                           |
| Stack           | Gateway with Ticket, Identity, AI, Knowledge, Analytics and Notifications on private networks; PostgreSQL 16 with per-service scoped logins; production Next.js build; OpenSearch 3.10 in the search drill only; Redis off; email off                                                     |
| AI provider     | `fake` (deterministic, no network). No live model was called                                                                                                                                                                                                                              |
| Seed            | `test` profile: 8 users, 10 tickets and 5 knowledge articles. The benchmark adds 100 synthetic users                                                                                                                                                                                      |
| Date            | November 25, 2026                                                                                                                                                                                                                                                                         |

## Reproduction

```sh
SD100=1 SD100_PASSIVE_SCAN=1 sh docker/verify-ticket-service.sh   # integrated gate and ZAP
SD100=1 SD100_PERF=1 sh docker/verify-ticket-service.sh           # 100-user benchmark
docker compose --profile ci run --rm backend-ci                   # PostgreSQL integration suite
```

Each run uses a disposable Compose project and removes its volumes on exit. Evidence is written
to `test-results/sd100/`. The [Ticket service runbook](../architecture/ticket-service.md)
describes the rollback procedure that the gate exercises.

## Results

PASS means the scenario ran and every assertion held on the tested revision. NOT RUN means the
scenario was not executed.

### Browser journeys (live)

Real Chromium against the production build, through the gateway to the services and PostgreSQL.
The spec is [`frontend/e2e/microservices.spec.ts`](../../frontend/e2e/microservices.spec.ts).

| ID  | Scenario                                                                                                                                                                                           | Result |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D1  | Employee submits and tracks a ticket. The technician routes, starts, adds an internal note, replies publicly and resolves. The employee sees the reply and resolution but never the internal note. | PASS   |
| D2  | The resolution reaches the employee's notification inbox.                                                                                                                                          | PASS   |
| D3  | The admin _Reports_ count of submitted tickets rises by exactly one for that ticket. Admin Knowledge lists articles.                                                                               | PASS   |
| D4  | The fake AI suggestion arrives without a reload. A Hardware technician accepts it.                                                                                                                 | PASS   |
| D5  | A stale second tab is refused with "Someone else changed this ticket", then saves on the reloaded version.                                                                                         | PASS   |
| D6  | A second employee gets _Ticket not found_ for another employee's ticket and is redirected away from `/technician`, `/admin` and `/technician/tickets/:id`.                                         | PASS   |
| D7  | With `ai-service` stopped, analysis stays queued and the technician still routes, starts and resolves in the browser.                                                                              | PASS   |

The other Playwright suites run against a mocked API (`installMockApi`). They are UI tests,
not integrated journeys: 472 passed, 88 skipped in `frontend-ci`.

### Authorization and data exposure

| ID  | Scenario                                                                                                                                                                                                                                                        | Result |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A1  | Role matrix over HTTP: cross-user reads return 404, employee and technician report requests return 403, admin succeeds                                                                                                                                          | PASS   |
| A2  | Private service commands need service credentials; the browser network has no route to any private listener                                                                                                                                                     | PASS   |
| A3  | Ticket's PostgreSQL login cannot write Identity, Knowledge or Notifications data                                                                                                                                                                                | PASS   |
| A4  | A technician removed from a team loses detail, events, comments, recommendations, analysis, list and queue access, even with a token issued before the removal (`teams.integration.test.ts`)                                                                    | PASS   |
| A5  | Response security headers on the frontend `/login`, gateway `/health/live` and `/api/auth/me`: CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, no `X-Powered-By`                                                                         | PASS   |
| A6  | Full PostgreSQL integration suite: RBAC, private notes, draft articles, secret redaction, idempotency, version conflicts, outbox, report queries. 59 files, 900 tests passed, 20 skipped (the OpenSearch suites run in the separate `search` job, which passed) | PASS   |
| A7  | All 16 migrations applied once on a fresh database, with zero schema drift (`check:drift`)                                                                                                                                                                      | PASS   |

### Failure, recovery and rollback

| ID  | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Result                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Ticket submission, routing and audit continue with AI, Notifications or Knowledge stopped, with Analytics paused, and with OpenSearch stopped (PostgreSQL fallback)                                                                                                                                                                                                                                                                                        | PASS                                                                                                                                                                     |
| F2  | Protected Ticket operations fail closed (503) while Identity is stopped                                                                                                                                                                                                                                                                                                                                                                                    | PASS                                                                                                                                                                     |
| F3  | AI worker crash: the replacement worker commits exactly one recommendation on attempt two after the abandoned lease expires                                                                                                                                                                                                                                                                                                                                | PASS                                                                                                                                                                     |
| F4  | Notification replay: a completed receipt forced to failed is consumed once, with one inbox row                                                                                                                                                                                                                                                                                                                                                             | PASS                                                                                                                                                                     |
| F5  | Ticket stopped: the gateway answers 503 with the request's correlation ID                                                                                                                                                                                                                                                                                                                                                                                  | PASS                                                                                                                                                                     |
| F6  | Rollback to the legacy layout reads the same persisted tickets and recommendations                                                                                                                                                                                                                                                                                                                                                                         | PASS                                                                                                                                                                     |
| F7  | **Integrity across F1–F6**: tickets 46→56, events 90→143, notifications 7→28, accepted recommendations 3→4. Zero instances of each of the following: a ticket with more than one accepted recommendation, a missing or duplicate review audit, a duplicate notification, a notification to a non-requester, a notification for an internal note, a job or delivery stuck on an expired lease (`drill-integrity-before.json`, `drill-integrity-after.json`) | PASS                                                                                                                                                                     |
| F8  | Redis interruption in the isolated stack                                                                                                                                                                                                                                                                                                                                                                                                                   | NOT RUN. Redis is off in this stack. It is covered against real PostgreSQL by `redisOutageDurability.integration.test.ts` and the fallback-store unit tests, which pass. |

### Passive security scan (ZAP)

ZAP 2.16.1 passively observed four unauthenticated responses from the disposable deployment:

- the frontend `/login`
- gateway `/health/live`
- `/api/auth/me`, expecting 401
- `/api/admin/reports/summary`, expecting 401

The plan is [`docker/sd100-passive-scan.yml`](../../docker/sd100-passive-scan.yml), and only the
local disposable origins are in scope. This is a passive header review, **not** a penetration
test or authenticated active scan.

| Finding                                                               | Before: revision `b27b244` | After: this run | Disposition                                                                                                                                                                      |
| --------------------------------------------------------------------- | -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Content Security Policy or clickjacking protection on the frontend | Medium                     | not reported    | **Fixed** in [#209](https://github.com/thomastran117/IT-Support-System/pull/209). The CSP has `frame-ancestors 'none'`, plus `X-Frame-Options: DENY`.                            |
| Missing `X-Content-Type-Options` (API and frontend)                   | Low ×2                     | not reported    | **Fixed** in #209: `nosniff` at both boundaries                                                                                                                                  |
| `X-Powered-By` on the frontend                                        | Low                        | not reported    | **Fixed** in #209: `poweredByHeader: false`; the gateway strips the header from upstream responses                                                                               |
| CSP `script-src 'unsafe-inline'`                                      | (no CSP)                   | Medium          | **Accepted** (risk R2 in the static report). Next's hydration bootstrap and the constant theme script are inline. A nonce-based CSP would force dynamic rendering of every page. |
| CSP `style-src 'unsafe-inline'`                                       | (no CSP)                   | Medium          | **Accepted.** Framework and component inline styles; style injection is lower risk and no user HTML is rendered.                                                                 |
| ZAP is out of date                                                    | Low ×2                     | Low ×2          | Scanner maintenance only. The pinned image is reproducible; refresh it in the next maintenance pass.                                                                             |

Zero high-severity alerts in either run.

### Latency and load

The full method, per-container resources and limitations are in the
[performance benchmark](performance-benchmark.md). It ran 100 user VUs (80 employees,
18 technicians and 2 admins) held for 5 minutes, plus one AI turnaround probe. That produced
23,456 requests in 6 min 25 s with **0 failed**.

| Request class                        | Samples | p50 (ms) | p95 (ms) | p99 (ms) |
| ------------------------------------ | ------: | -------: | -------: | -------: |
| Non-AI reads                         |  22,156 |     5.39 |    11.83 |    17.69 |
| Ticket submission                    |   1,036 |     9.44 |    18.01 |    25.70 |
| AI turnaround with the fake provider |     132 |      262 |      270 |      277 |

The gate also repeats the short topology comparison: one request per endpoint per round, 30
measured rounds, the same host and the same seed. It isolates the cost of the service split, not
load.

| Request       | Legacy p50 / p95 / p99 (ms) | Isolated p50 / p95 / p99 (ms) |
| ------------- | --------------------------- | ----------------------------- |
| Teams         | 8.19 / 13.14 / 14.20        | 13.05 / 24.67 / 52.65         |
| Reports       | 14.18 / 22.40 / 30.03       | 16.91 / 31.57 / 58.65         |
| Submit ticket | 20.25 / 32.39 / 36.46       | 21.45 / 34.89 / 75.84         |

| Layout                            | Mean application CPU (sum) | Mean application memory (sum) | PostgreSQL CPU / memory |
| --------------------------------- | -------------------------- | ----------------------------- | ----------------------- |
| Gateway, legacy API and worker    | 31.7%                      | 334.8 MiB                     | 8.7% / 83.2 MiB         |
| Gateway and six isolated services | 64.9%                      | 593.3 MiB                     | 10.9% / 82.2 MiB        |

These figures are from four `docker stats` samples per container. CPU is a percentage of one
logical CPU.

## Measured targets

| Deliverable 1 target                    | Evidence                                                                               | Status                            |
| --------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| ≥ 100 concurrent users                  | 100 user VUs for 5 min, 0 errors, one 4-CPU host                                       | **MET** (synthetic workload)      |
| Non-AI API response < 500 ms            | p95 11.83 ms at 100 users                                                              | **MET**                           |
| Ticket submission < 2 s                 | p95 18.01 ms at 100 users                                                              | **MET**                           |
| AI analysis < 10 s                      | 270 ms p95 with the fake provider only                                                 | **NOT VERIFIED** for a real model |
| AI suggestion accuracy                  | no live-provider evaluation on real tickets (see [AI evaluation](../ai-evaluation.md)) | **NOT VERIFIED**                  |
| 99% availability during operating hours | no long-running deployment was monitored                                               | **NOT VERIFIED**                  |

## Risk register (dynamic)

| ID  | Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Severity                                                                           | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6  | The OpenSearch-outage probe intermittently got a 503 through the gateway (2 of about 6 CI runs). **Root cause:** on an internal Docker network, the name of a stopped container takes about 5 s to fail. Node's default `dns.lookup` runs on the four-thread libuv pool, so the search client's failing lookups starved Ticket's unrelated lookups (Identity, PostgreSQL) past the 2.5 s gateway timeout. The gateway's forwarding had the same exposure. | Medium (a real availability defect: one dead dependency could stall a healthy one) | **Fixed** in [#218](https://github.com/thomastran117/IT-Support-System/pull/218). The search transport (through an `undici` dispatcher) and the gateway's upstream requests resolve names with c-ares (`nonBlockingLookup` in `@smartdesk/service-runtime`), off the threadpool. Reproduction on an internal network: with six lookups to a vanished name pending, a healthy dependency answered in 14,976 ms before the fix and 4 ms after; the missing name failed in 13 ms instead of 5,024 ms. Other outbound `fetch` clients still use the system resolver; their targets (Identity, Ticket) fail the request closed when absent. |
| R7  | Identity allows 10 logins per minute per source address, and every gate login arrives from the gateway                                                                                                                                                                                                                                                                                                                                                    | Low                                                                                | Accepted. The gate stays under the limit (about 8 browser logins). The benchmark mints tokens instead, so login latency under load is not measured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R8  | Load and latency come from one shared CI host with a small, fresh dataset                                                                                                                                                                                                                                                                                                                                                                                 | Medium                                                                             | Accepted and documented. The figures are not production SLOs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R9  | AI latency and accuracy are unmeasured against a live model                                                                                                                                                                                                                                                                                                                                                                                               | Medium                                                                             | Accepted. Live calls need provider credentials and cost; see the targets above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R10 | The passive scan covers four unauthenticated responses                                                                                                                                                                                                                                                                                                                                                                                                    | Low                                                                                | Accepted. Authenticated behaviour is covered by D1–D7, A1–A7 and the integration suite, not by ZAP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

There is no unresolved high or critical dynamic finding.
