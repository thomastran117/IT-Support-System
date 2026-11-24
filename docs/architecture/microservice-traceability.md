# Deliverable 1 microservice traceability

The default Compose deployment runs the modular API and worker. The opt-in overlay implements
the original gateway, Ticket, AI, Notifications, and Analytics service boundaries, plus the
later Identity and Knowledge extractions. Both layouts run the same browser workflows.
[Isolated deployment and rollback](ticket-service.md) · [Architecture decision](microservices-adr.md)

## Implemented boundaries

| Deliverable 1 capability                         | Implementation in isolated Compose                                                                                                                                                                                                                                   | Verification                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public gateway and stable browser API            | [Fastify gateway](../../backend/gateway/src/app.ts), [route ownership registry](../../backend/gateway/src/routing.ts), and [public contracts](../api.md)                                                                                                             | [Gateway tests](../../backend/gateway/test/gateway.test.ts) cover method, body, cookies, request IDs, timeouts, and route ownership. [Real browser journey](../../frontend/e2e/microservices.spec.ts) covers the employee, technician, and administrator portals.                                         |
| Ticket lifecycle, operational queries, and audit | [Ticket entrypoint](../../backend/src/ticketServer.ts) and [workflow transactions](../../backend/src/db/services/ticketService.ts) own tickets, catalogs, teams, comments, recommendations, review, audit, and Q01–Q04.                                              | [Scoped database tests](../../backend/test/integration/serviceDbAccess.integration.test.ts) exercise grants and operational queries. [Isolated lifecycle](../../docker/verify-ticket-service.sh) checks idempotency, stale versions, private notes, manual routing through dependency loss, and rollback. |
| AI-assisted analysis and human decision          | [AI service](../../backend/services/ai/src/server.ts) retrieves allowlisted inputs and published Knowledge. [Ticket commands](../../backend/src/modules/tickets/internalAnalysisRoutes.ts) own leases and durable results. Review happens in the Ticket transaction. | [AI command tests](../../backend/test/integration/aiService.integration.test.ts) and the [isolated lifecycle](../../docker/verify-ticket-service.sh) verify scoped commands, references, one result after worker recovery, and human review. The full-stack run uses the fake provider.                   |
| Notifications and replay                         | [Notifications service](../../backend/services/notifications/src/server.ts) consumes the [PostgreSQL outbox](service-outbox.md) and owns recipient inbox and delivery state.                                                                                         | [Notifications lifecycle](../../docker/verify-notifications-service.sh) and [outbox integration tests](../../backend/test/integration/serviceOutbox.integration.test.ts) cover committed delivery, retries, replay, and duplicate prevention. The isolated full-stack run exercises the in-app channel.   |
| Administrator reporting                          | [Analytics service](../../backend/services/analytics/src/app.ts) uses [Q05–Q14 queries](../../packages/analytics/sql) and scoped read grants.                                                                                                                        | [Analytics lifecycle](../../docker/verify-analytics-service.sh) exercises report parity and bounded outages. The real browser journey exercises the admin reports page.                                                                                                                                   |
| Account authority and published Knowledge        | [Identity](identity-service.md) owns sessions and revocation. [Knowledge](knowledge-service.md) owns authoring, publication, and AI retrieval.                                                                                                                       | The [Identity drill](../../docker/verify-identity-service.sh) checks session continuity and revocation. The [Knowledge drill](../../docker/verify-knowledge-service.sh) checks authoring, publication, outage, and rollback.                                                                              |
| Visibility, recovery, and deployment continuity  | [Correlated JSON events](service-observability.md), [scoped data ownership](../database/service-access.md), and [Compose cutover](ticket-service.md)                                                                                                                 | [SD-100 dynamic analysis](../testing/microservice-dynamic-analysis.md) covers service and search loss, correlation, rollback on the same database, and measured latency and resource use.                                                                                                                 |

## Deferred boundaries and unverified targets

- **Separate databases per service.** PostgreSQL row policies, grants, and scoped logins enforce
  ownership on one PostgreSQL server. Shared foreign keys and narrow cross-owner reads remain.
  Ticket retains the AI queue and recommendation transaction. Analytics reads committed facts
  through grants. Separate databases and an independent analytics projection are deferred.
- **Additional infrastructure.** Compose and the PostgreSQL outbox are the deployed
  orchestration and transport. An external broker and Kubernetes deployment are deferred.
  Redis and OpenSearch are optional adapters. The browser tests exercise PostgreSQL fallback
  when the isolated OpenSearch dependency stops.
- **Production and scale targets.** The recorded workload uses cloned synthetic fixtures and
  three concurrent requests per round. The 100-user workload, production uptime window, and
  live provider validation remain unverified by this gate.
  [Load and latency criteria](https://github.com/thomastran117/IT-Support-System/issues/69) · [AI evaluation](../ai-evaluation.md)

## E10 and E11 evidence

The separate [static report](../testing/microservice-static-analysis.md) records the Semgrep
reviews and open dependency advisories. The [dynamic report](../testing/microservice-dynamic-analysis.md)
records actual test, benchmark, and passive scan outcomes, including open response-header findings.
The merged SD-100 run published raw measurement and scan results.
[E10 evidence artifact](https://github.com/thomastran117/IT-Support-System/actions/runs/45485914742/artifacts/14965496760)

GitHub reruns the isolated verification and static scans on independent runners. The frontend
workflow publishes `microservice-verification` for browser, resilience, measurement, and passive
scan evidence and `microservice-static-analysis` for source and lockfile results. The existing
required checks aggregate their parallel suites.
[Backend workflow](../../.github/workflows/backend.yml) · [Frontend workflow](../../.github/workflows/frontend.yml)

The launch and rollback commands, [generated ERD](../database/erd.md), ownership map, and
requirements matrix provide the optional microservice evidence for the E11 handoff.
[E10 quality and evidence](https://github.com/thomastran117/IT-Support-System/issues/11) · [E11 deployment and handoff](https://github.com/thomastran117/IT-Support-System/issues/12)
