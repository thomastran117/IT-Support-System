# Static analysis report (Deliverable 2)

This is the final static analysis of SmartDesk's release candidate. It covers:

- the Next.js frontend
- the Fastify backend and gateway
- the six extracted Node.js services and the shared packages
- Compose files, the Dockerfile and the GitHub Actions workflows

Runtime behaviour, header scans and load are in the separate
[dynamic analysis report](microservice-dynamic-analysis.md).

## Tested revision

| Item                        | Value                                                                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source revision             | `e67f9da4256ce57a3ddbdec35d0bc87c4f8d0ec6`, the head of the E10 change stack ([#209](https://github.com/thomastran117/IT-Support-System/pull/209)–[#215](https://github.com/thomastran117/IT-Support-System/pull/215)). CI scanned it as merge ref `b4bb2fb5a39a0f4d08420842cc028cdc3e41a443` |
| Source and dependency scans | [frontend run 45688894263](https://github.com/thomastran117/IT-Support-System/actions/runs/45688894263), job _Source and dependency scans_, artifact `microservice-static-analysis`                                                                                                           |
| Secret scan                 | [PR #216](https://github.com/thomastran117/IT-Support-System/pull/216) CI, same job and artifact (`gitleaks.json`). That PR adds only the scan step and this report; no application source changed                                                                                            |
| Date                        | November 25, 2026                                                                                                                                                                                                                                                                             |

Later commits that change only documentation do not change these results.

## Executed checks

| Check                          | Tool and version                                                                                                                                | Scope                                                                                                                                                 | Observed result                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source and configuration rules | Semgrep CE 1.150.0, five repository rules ([`docker/sd100-semgrep.yml`](../../docker/sd100-semgrep.yml)), no network, metrics off               | `frontend/src`, `backend/src`, `backend/gateway/src`, `backend/services`, `packages`, `Dockerfile.dev`, Compose files, `docker/`, `.github/workflows` | 284 files scanned, 0 errors, **3 matches**                                                                                                                                                                                                 |
| Dependency advisories          | `npm audit --package-lock-only` on Node 22.23.5 / npm 10.9.9 ([`docker/audit-microservice-deps.mjs`](../../docker/audit-microservice-deps.mjs)) | all 16 committed lockfiles of the deployed packages                                                                                                   | 16 reports, **0 advisories at any severity**                                                                                                                                                                                               |
| Committed secrets              | gitleaks 8.28.0, default rules, `--redact`, no network                                                                                          | the Git history reachable from the tested merge ref (106 commits in CI)                                                                               | **4 matches in 3 locations, all false positives** (below)                                                                                                                                                                                  |
| Compile and lint               | `tsc --noEmit`, ESLint and Prettier per package, through `backend-ci`, `frontend-ci`, the gateway job and the service lifecycle jobs            | backend, gateway, services, frontend, contracts, db                                                                                                   | pass in the [backend](https://github.com/thomastran117/IT-Support-System/actions/workflows/backend.yml) and [frontend](https://github.com/thomastran117/IT-Support-System/actions/workflows/frontend.yml) workflows on the tested revision |

The five Semgrep rules flag:

- unsafe Prisma raw SQL (`$queryRawUnsafe`, `$executeRawUnsafe`)
- `innerHTML` assignment
- `dangerouslySetInnerHTML`
- `eval` and `new Function`
- `privileged: true` in Compose or CI

Coverage is limited to these rules: this is a targeted review aid, not a full SAST product. The
scans are **report-only** in CI, a project decision for E10. A finding is recorded in the
artifact and dispositioned here; it does not fail the build.

## Findings and disposition

### Source rules (Semgrep)

| #   | Rule           | Location                                                                           | Disposition                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | unsafe raw SQL | [`packages/analytics/src/reports.ts:123`](../../packages/analytics/src/reports.ts) | **Reviewed, accepted.** The SQL text is one of the repository's own `packages/analytics/sql/Q*.sql` files, chosen by a constant name. The report window is passed as the bound parameters `$1` and `$2` after validation. A unit test, `backend/test/unit/analytics/reports.test.ts`, asserts the dates never appear in the SQL text and that unauthorized or invalid calls run no query. |
| S2  | unsafe raw SQL | [`backend/src/db/seed/run.ts:94`](../../backend/src/db/seed/run.ts)                | **Reviewed, accepted.** `TRUNCATE` of a fixed table list for the seed `--reset` option. No input reaches the identifiers, and `assertResettable` refuses any database whose name does not contain `test`.                                                                                                                                                                                 |
| S3  | raw JSX HTML   | [`frontend/src/app/layout.tsx:18`](../../frontend/src/app/layout.tsx)              | **Reviewed, accepted. New since the previous run.** The inline script is the constant `themeInitScript` from `frontend/src/lib/theme.ts`. It reads one `localStorage` key and only ever sets `data-theme` to the literal `light` or `dark`. No user or server data is interpolated. It is the reason the frontend CSP keeps `'unsafe-inline'` in `script-src` (risk R2).                  |

No `innerHTML`, `eval`, `new Function` or privileged containers were found. The k6 benchmark
container runs as `user: '0:0'` only so it can write to the evidence folder. It is not privileged,
has no host mounts other than the read-only script folder and two `test-results` folders, and
exists only in the `microservice-perf` profile.

### Dependencies (npm audit)

| Advisory                                                                                                                                                                                | Previous run (revision `b27b244`)         | This run                                  | Disposition                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nodemailer: addressparser recipient smuggling and ReDoS, DNS-cache TLS servername reuse, `raw`/`resolveContent` file and URL access bypass, SMTP parser DoS (15 advisories, `<=10.1.3`) | high: `backend`, `packages/notifications` | none                                      | **Fixed** in [#210](https://github.com/thomastran117/IT-Support-System/pull/210): `nodemailer` 8.0.11 → 10.6.1. Retested with a real SMTP conversation against a loopback server (`backend/test/unit/notifications/email.test.ts`). Live Gmail delivery was not retested, and email is off by default.                          |
| Effect ReDoS in `Schema.TemplateLiteral` (`<=3.22.0`, via `prisma` → `@prisma/config`)                                                                                                  | high: `backend` (3 entries in one chain)  | none                                      | **Fixed** in [#210](https://github.com/thomastran117/IT-Support-System/pull/210): an npm override pins `effect` to 3.22.5 under Prisma 7.10.1, with no Prisma downgrade. `prisma generate`, `migrate deploy`, the drift check and the full integration suite pass with it. Remove the override when Prisma ships a patched pin. |
| **Totals**                                                                                                                                                                              | 5 high, 0 critical                        | **0 at any severity** across 16 lockfiles |                                                                                                                                                                                                                                                                                                                                 |

### Committed secrets (gitleaks)

| #     | Location                                                    | Match                    | Disposition                                                                                                                    |
| ----- | ----------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| G1–G2 | `backend/experiments/hybrid-knowledge/encoder.ts:9-10`      | 64-character hex strings | **False positive.** SHA-256 checksums that pin the downloaded model files. They are public integrity values, not credentials.  |
| G3    | `backend/test/integration/aiFailure.integration.test.ts:19` | `sk-live-TOPSECRETKEY…`  | **False positive by design.** A fake key that the redaction tests inject to prove it never reaches prompts, logs or responses. |
| G4    | `backend/test/unit/notifications/serviceOutbox.test.ts:24`  | `leaseToken: '<uuid>'`   | **False positive.** A fixed UUID lease token in a unit-test fixture.                                                           |

A local full-clone scan of 219 commits found the same three locations, repeated in older commits (7 matches). No real credential was found in the history. Local `.env` files are git-ignored and were never
committed. CI and the verification scripts generate their keys per run (for example, the
service signing keys in `verify-ticket-service.sh`) or use labelled fixture values.

## Risk register (static)

| ID  | Risk                                                                                        | Severity | Status and mitigation                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The `effect` override diverges from Prisma's pinned dependency                              | Low      | Accepted. It stays within the same major (3.x); generate, migrate, drift and integration tests pass. Drop it on the next Prisma release.                                                                                                                                    |
| R2  | The frontend CSP allows `'unsafe-inline'` scripts (Next bootstrap and the theme script, S3) | Low      | Accepted. No user-controlled HTML is rendered (Markdown is rendered without raw HTML; no `dangerouslySetInnerHTML` on data), and `object-src 'none'`, `base-uri 'self'` and `frame-ancestors 'none'` remain. Nonce-based CSP would require dynamic rendering of every page. |
| R3  | Semgrep coverage is five targeted rules only                                                | Medium   | Open, documented. The rules are complemented by TypeScript strict mode, ESLint, the authorization integration suite and the dynamic report. A broader SAST ruleset was not run.                                                                                             |
| R4  | The scans are report-only in CI                                                             | Low      | Accepted project decision. This report dispositions every finding; a new high advisory would appear in the artifact, not as a failed check.                                                                                                                                 |
| R5  | Nodemailer 10 is untested against live Gmail TLS                                            | Low      | Open. Email is opt-in (`EMAIL_TRANSPORT=none` by default); the SMTP protocol path is tested against a loopback server.                                                                                                                                                      |

There is no unresolved high or critical static finding.

## Reproduction

```sh
sh docker/verify-microservice-static.sh            # Semgrep, npm audit and gitleaks
docker compose --profile ci run --rm backend-ci    # compile, lint, unit and integration
docker compose --profile ci run --rm frontend-ci   # compile, lint, unit, build and browser
```

The static runner writes these files under `test-results/sd100/`:

- `static-revision.txt`
- `semgrep.json`
- `npm-audit.json`
- `gitleaks.json`, redacted

The frontend workflow publishes them as the `microservice-static-analysis` artifact, kept for
14 days. The secret scan needs a full clone (`fetch-depth: 0` in CI).
