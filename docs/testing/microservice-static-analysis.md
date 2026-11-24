# SD-100 static analysis

The November 24, 2026 run scanned SmartDesk's adopted legacy and isolated runtimes
at revision `b27b24459abb273d95163a04bccacf002f014c54`. It covered the Next.js frontend,
Fastify backend and gateway, extracted Node.js services, shared packages, Compose and
GitHub Actions. The lockfile audit covered the 16 packages used by these deployments.

## Executed checks

| Check                         | Tool                                                     | Measured outcome                                                                           |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Source and configuration scan | Semgrep CE 1.150.0, five local rules, telemetry disabled | 275 files scanned, 2 rule matches, 0 scanner errors                                        |
| Dependency audit              | Node 22.23.5 and npm 10.9.9, full committed lockfiles    | 16 reports returned, 5 high package entries across 2 lockfiles, 0 critical package entries |

The Semgrep rules check Prisma raw SQL calls, raw HTML sinks, dynamic code evaluation,
and privileged Compose or CI containers. The scan runs without network access. Its
coverage is limited to these rules. The npm audit submits package and version metadata
to the configured npm advisory registry. [Semgrep CI documentation](https://semgrep.dev/docs/semgrep-ci/sample-ci-configs)

## Findings and disposition

| Finding                                | Evidence                                                                                       | Disposition                                                                                                                                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raw Prisma report query                | `packages/analytics/src/reports.ts:123`                                                        | Reviewed. Call sites select repository-owned SQL files and pass validated date bounds as parameters.                                                                                                                                                               |
| Raw Prisma fixture reset               | `backend/src/db/seed/run.ts:62`                                                                | Reviewed. Identifiers come from the fixed fixture table list. The reset path checks for a test database before truncation.                                                                                                                                         |
| High Nodemailer advisories             | `backend/package-lock.json` and `packages/notifications/package-lock.json`                     | Open. The same package family is reported in both lockfiles. npm proposes 10.6.1, a major upgrade. SMTP is disabled in the isolated verification. Upgrade and retest SMTP separately under [SD-059](https://github.com/thomastran117/IT-Support-System/issues/71). |
| High Effect advisory in Prisma tooling | `backend/package-lock.json` reports `effect`, `@prisma/config`, and `prisma` in the same chain | Open. npm proposes a major Prisma downgrade. Validate a supported Prisma release with a patched dependency and rerun migration and compiler checks under [SD-059](https://github.com/thomastran117/IT-Support-System/issues/71).                                   |

The Nodemailer results include multiple advisories for the same installed package.
The reported Prisma package entries include transitive propagation of one advisory.
The static scan verifies source patterns and known dependency advisories. Runtime
authentication, network scope, and response behavior are covered by the [dynamic report](microservice-dynamic-analysis.md).

## Reproduction

```sh
sh docker/verify-microservice-static.sh
docker compose --profile ci run --rm backend-ci
docker compose --profile ci run --rm frontend-ci
```

The static runner writes the revision, Semgrep JSON, and per-lockfile npm results under
`frontend/test-results/sd100/`. The existing backend and frontend workflows run the
package compiler and lint checks.
