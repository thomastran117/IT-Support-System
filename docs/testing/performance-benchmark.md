# SD-057 sustained load benchmark

This benchmark puts 100 concurrent synthetic users on the isolated deployment (gateway, six
services, PostgreSQL) for five minutes. It measures latency, error rate and resource use against
the Deliverable 1 performance targets. It replaces the earlier 90-request sample in the
[dynamic report](microservice-dynamic-analysis.md) as the evidence for those targets. It is a
synthetic measurement on one CI runner, not a production SLO.

## Reproduction

```sh
SD100=1 SD100_PERF=1 sh docker/verify-ticket-service.sh   # PERF_HOLD=5m by default
```

The [performance workflow](../../.github/workflows/performance.yml) runs the same command on every
pull request, on every push to `main`, and on manual dispatch. It uploads the `performance-benchmark` artifact, which holds:

- the k6 summary JSON
- the k6 log
- `docker stats` samples
- seed and after counts
- the tested revision

The scenario is in [`tests/performance/k6/smartdesk.js`](../../tests/performance/k6/smartdesk.js).

## Method

| Item               | Value                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool               | k6 1.4.2 (`grafana/k6:1.4.2`), on the stack's public network, calling the gateway directly                                                                            |
| Stack              | Gateway with Ticket, Identity, AI, Knowledge, Analytics and Notifications on private networks; PostgreSQL 17; Redis and OpenSearch disabled; email off                |
| AI provider        | `fake` (deterministic, no network call). AI timings are **mock** turnaround, not model latency                                                                        |
| Users              | 80 employees, 18 technicians (all in Network & Access) and 2 administrators, each a separate seeded account. One extra probe VU measures AI turnaround. Peak VUs: 101 |
| Profile            | 1 min ramp to 100, 5 min hold, 20 s ramp down. Each VU waits 1–3 s between steps (administrators 3–6 s)                                                               |
| Employee loop      | list own tickets, open one with its comments, submit a ticket about one iteration in five, then read unread notifications                                             |
| Technician loop    | team queue, unrouted backlog, one ticket's detail and events, then the teams list                                                                                     |
| Administrator loop | report summary and AI evaluation for the last 30 days                                                                                                                 |
| AI probe           | an employee submits; a technician polls `GET /api/tickets/:id/analysis` every 250 ms until `COMPLETED`                                                                |
| Authentication     | Identity mints the access tokens before the run. Login is limited to 10 per minute per address and every VU shares one address, so **login latency is not measured**  |
| Thresholds         | reported, not enforced: k6 exit 99 is recorded as NOT MET instead of failing the job                                                                                  |

## Results — CI run, November 25, 2026

| Item     | Value                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Revision | branch head `1a97811cb3d1e764fbf41a702be6fdeff53780e8` ([PR #214](https://github.com/thomastran117/IT-Support-System/pull/214)), tested as the PR merge ref `72b39be60cdb118409bdc8f408ea3d81aa193e4a` |
| Run      | [performance #45545324951](https://github.com/thomastran117/IT-Support-System/actions/runs/45545324951), `performance-benchmark` artifact                                                              |
| Host     | GitHub-hosted `ubuntu-latest`: x86_64, 4 logical CPUs, 15.6 GiB. Client and stack share the host                                                                                                       |
| Duration | 385 s (6 min 25 s)                                                                                                                                                                                     |
| Requests | 23,456 HTTP requests (60.9/s), 0 failed. 23,192 checks, 0 failed                                                                                                                                       |
| Data     | seed of 108 users and 44 tickets, rising to 1,080 tickets. 1,036 submissions, 1,070 AI jobs completed, none left queued or failed                                                                      |

| Request class                                       | Samples | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| --------------------------------------------------- | ------: | -------: | -------: | -------: | -------: |
| Non-AI reads (all roles)                            |  22,156 |     5.39 |    11.83 |    17.69 |    74.74 |
| Ticket submission                                   |   1,036 |     9.44 |    18.01 |    25.70 |    40.40 |
| AI turnaround, fake provider (submit to suggestion) |     132 |      262 |      270 |      277 |      284 |
| All requests                                        |  23,456 |     5.51 |    12.47 |    18.70 |    74.74 |

| Deliverable 1 target    | Measured (p95, 100 concurrent users)       | Status                                                                                                                                                |
| ----------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrency ≥ 100 users | 100 user VUs sustained for 5 min, 0 errors | **MET** (synthetic, one host)                                                                                                                         |
| Non-AI API < 500 ms     | 11.83 ms                                   | **MET**                                                                                                                                               |
| Ticket submission < 2 s | 18.01 ms                                   | **MET**                                                                                                                                               |
| AI analysis < 10 s      | 270 ms with the fake provider              | **NOT VERIFIED** for a real model: the fake provider adds no model latency, so this shows only that the queue, worker and lease path adds about 0.3 s |
| 99% availability        | not measured                               | **NOT VERIFIED**: a 6-minute run says nothing about operating-hours uptime                                                                            |

The targets are applied to p95. Every request class also meets them at p99 and at max.

### Resource use (`docker stats`, 193 samples per container)

CPU is a percentage of one logical CPU. Memory is the working set.

| Container             | CPU mean / max | Memory mean / max (MiB) |
| --------------------- | -------------- | ----------------------- |
| ticket-service        | 22.6% / 49.4%  | 130.7 / 148.9           |
| postgres              | 14.2% / 26.2%  | 114.1 / 123.2           |
| identity-service      | 9.6% / 26.6%   | 93.5 / 102.2            |
| notifications-service | 6.9% / 29.1%   | 86.9 / 109.9            |
| gateway               | 5.3% / 16.6%   | 104.4 / 114.8           |
| ai-service            | 5.2% / 16.1%   | 66.4 / 86.5             |
| knowledge-service     | 3.6% / 16.9%   | 70.5 / 83.7             |
| analytics-service     | 2.9% / 15.0%   | 64.9 / 81.5             |

The busiest container, Ticket, used about half of one CPU at peak. The run did not reach
saturation, so it shows no capacity limit, only that 100 users with this think time are well
within one 4-CPU host.

## Limitations

- **Small, fresh dataset:** about 1,000 tickets by the end. Query plans and latency on a
  production-sized table are not measured.
- **Client on the same host:** the client and stack share one host, so there is no network
  latency between them.
- **Shared CI runners:** absolute numbers vary between runs.
- **Synthetic workload:** the think time and the 20% submission rate are assumptions, not
  observed user behaviour.
- **AI:** with the fake provider, the AI figures say nothing about live-model latency or accuracy.
- **Excluded components:** login, Redis, OpenSearch, email and the frontend were not part of the
  load.
- **No retest after tuning:** the first run met every measurable target, so no improvement
  retest was needed.
