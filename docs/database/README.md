# SmartDesk database

PostgreSQL 16 is the system of record for tickets, identities and team membership, human review of AI
proposals, knowledge articles, the audit trail and reporting. This folder describes the schema **as
deployed by the migrations**, not a proposal.

| Document                                   | Contents                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| [erd.md](./erd.md)                         | Mermaid ERD of all 11 entities and the relationship table                |
| [data-dictionary.md](./data-dictionary.md) | Every column: type, null, default, key, unique, indexes, meaning, CHECKs |
| [schema-spec.json](./schema-spec.json)     | Machine-readable source for the two files above                          |
| [queries.md](./queries.md)                 | Q01-Q10: SQL files, parameters, result columns, units, limits            |
| [fixtures.md](./fixtures.md)               | Seed data, IDs and hand-calculated expected report values                |
| [concurrency.md](./concurrency.md)         | Transactions, locking, error mapping                                     |
| [deviations.md](./deviations.md)           | Every deliberate difference from Deliverable 2, with rationale           |

Source of truth for the design: SEG4105 Project 1, Deliverable 2 (ERD §2, relationship/lifecycle rules
§2.1-2.2, data dictionary §3, SQL §4). Epic: GitHub #2 (E01).

## Keeping the documents honest

`erd.md` and `data-dictionary.md` are **generated** from `schema-spec.json`, and the integration test
`dictionary.integration.test.ts` compares that spec with the migrated database (columns, types,
nullability, defaults, primary/foreign keys including the composite key, delete rules, CHECK names and
rules, indexes) and the Markdown with the spec. After changing a migration:

1. run the tests; the failing assertion shows what differs from the live schema;
2. update `docs/database/schema-spec.json` (and `deviations.md` if the design changed);
3. run `npm run docs:db` and commit the regenerated files.

## Source-to-implementation mapping

| Deliverable 2 entity        | Table                     | Prisma model            |
| --------------------------- | ------------------------- | ----------------------- |
| User                        | `users`                   | `User`                  |
| Support team                | `support_teams`           | `SupportTeam`           |
| Team membership             | `team_members`            | `TeamMember`            |
| Ticket category             | `ticket_categories`       | `TicketCategory`        |
| Ticket                      | `tickets`                 | `Ticket`                |
| Ticket comment              | `ticket_comments`         | `TicketComment`         |
| Ticket event (audit)        | `ticket_events`           | `TicketEvent`           |
| AI recommendation           | `ai_recommendations`      | `AiRecommendation`      |
| Knowledge article           | `knowledge_articles`      | `KnowledgeArticle`      |
| Recommendation-article link | `recommendation_articles` | `RecommendationArticle` |
| Classification label        | `classification_labels`   | `ClassificationLabel`   |

Migrations: `0000_init` (pgcrypto), `0001_core_schema` (tables), `0002_constraints_indexes` (CHECKs,
composite FK, indexes, append-only trigger). Schema file: `backend/prisma/schema.prisma`.

## Enumerations (enforced by CHECK constraints)

| Column                                 | Allowed values                                            |
| -------------------------------------- | --------------------------------------------------------- |
| `users.role`                           | `EMPLOYEE`, `TECHNICIAN`, `ADMIN`                         |
| `tickets.status`                       | `OPEN`, `TRIAGED`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`    |
| `tickets.priority`                     | `UNSET`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`              |
| `ai_recommendations.proposed_priority` | NULL, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` (never `UNSET`) |
| `ai_recommendations.review_status`     | `PENDING`, `ACCEPTED`, `OVERRIDDEN`, `REJECTED`           |
| `ticket_events.event_type`             | see the catalogue below                                   |

### Audit event catalogue

| Event              | Written when                                                                | `details` (ids/values only)                |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------------ |
| `CREATED`          | a ticket is created                                                         | `{}`                                       |
| `STATUS_CHANGED`   | OPEN→TRIAGED, TRIAGED→IN_PROGRESS, RESOLVED→CLOSED (also system auto-close) | `{from, to}` (+ optional `reason`)         |
| `TEAM_ASSIGNED`    | the **first** approved team assignment                                      | `{from: null, to}`                         |
| `TEAM_REASSIGNED`  | any later approved team change                                              | `{from, to}`                               |
| `CATEGORY_UPDATED` | an approved category changes                                                | `{from, to}`                               |
| `PRIORITY_UPDATED` | an approved priority changes                                                | `{from, to}`                               |
| `ASSIGNEE_UPDATED` | the assignee changes (also cleared on team change)                          | `{from, to}`                               |
| `COMMENT_ADDED`    | a comment is posted                                                         | `{commentId, isInternal}` (never the text) |
| `AI_REVIEWED`      | a technician accepts/overrides/rejects a recommendation                     | `{recommendationId, decision}`             |
| `RESOLVED`         | IN_PROGRESS→RESOLVED                                                        | `{from}`                                   |
| `REOPENED`         | RESOLVED/CLOSED→OPEN                                                        | `{from}`                                   |

`actor_id = NULL` means a system actor (for example the 14-day auto-close). Unapproved AI suggestions
never create events or touch ticket columns.

## Which rule is enforced where

| Rule                                                                                         | Database (always)                                     | Service layer (`backend/src/db/services`)    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| New tickets start OPEN / UNSET with no team, category or assignee                            | column defaults                                       | `createTicket`                               |
| Valid role, status, priority, review status, event type                                      | CHECK                                                 |                                              |
| Blank text rejected; lowercase unique email; unique team/category names                      | CHECK / UNIQUE                                        | input validation for friendly errors         |
| TRIAGED / IN_PROGRESS need category, priority ≠ UNSET and team                               | CHECK                                                 | `transitionTicket`, `approveRouting`         |
| Assignee must belong to the assigned team                                                    | composite FK `tickets → team_members`                 | active-technician check                      |
| Assignee requires a team                                                                     | CHECK (the FK ignores NULLs, see below)               |                                              |
| RESOLVED / CLOSED need summary and `resolved_at ≥ created_at`; other statuses have both NULL | CHECK                                                 | reopen clears the fields                     |
| Which status edge is allowed (OPEN→TRIAGED→IN_PROGRESS→RESOLVED→CLOSED; reopen)              | **not expressible** (a CHECK sees only the final row) | `ALLOWED_TRANSITIONS`                        |
| Review completeness; `reviewed_at ≥ created_at`; confidence 0..1; rank > 0 and unique        | CHECK / UNIQUE                                        | one reviewer wins (row lock)                 |
| Original AI proposal immutable                                                               | not enforced by a trigger                             | `markReviewed` never updates `proposed_*`    |
| Audit events append-only                                                                     | trigger rejects UPDATE/DELETE                         | events written in the mutation's transaction |
| History never cascade-deleted                                                                | all FKs `ON DELETE RESTRICT`                          | deactivate instead of delete                 |
| Who may see what (own tickets, team queue, internal notes, reports)                          |                                                       | `operationalQueries.ts`, `reports.ts`        |
| Technician/team scope, active team/category                                                  |                                                       | `ticketService.ts`                           |

**Team membership and NULLs.** The foreign key `tickets(assigned_team_id, assignee_id) →
team_members(team_id, user_id)` uses PostgreSQL's default `MATCH SIMPLE`: if either column is NULL the
key is not checked. A team with no assignee is therefore valid (the queue before anyone picks the ticket
up), while an assignee without a team is stopped by `ck_tickets_assignee_requires_team`. Removing a
membership that a ticket still uses fails (`RESTRICT`).

**Manual AI fallback.** Nothing in the schema requires an `ai_recommendations` row; a technician can
triage, work and resolve a ticket when the AI provider is down. Unrouted tickets appear in Q03.

## Runtime extensions to the 11-table baseline

Deployed: credentials (SD-013, migration `0003_auth_credentials`: two columns on `users`, see `deviations.md` #5) and the admin audit trail (SD-017, migration `0004_admin_audit_log`: table `admin_audit_log`, see `deviations.md` #6). Planned additions, each to be added by its own migration and recorded here and in
`deviations.md` without altering the eleven baseline tables:

| Extension                    | Issue | Purpose                                                       |
| ---------------------------- | ----- | ------------------------------------------------------------- |
| ~~Credentials and sessions~~ | #25   | done as two `users` columns; no session table (stateless JWT) |
| ~~Admin audit trail~~        | #29   | done as the append-only `admin_audit_log` table               |
| Durable AI analysis jobs     | #47   | idempotent job records for the worker                         |
| Notifications                | #52   | employee notification records                                 |

## Running it (npm workspaces only)

```bash
docker compose up -d postgres                     # or any PostgreSQL 16 server
npm run db:migrate                                # prisma migrate deploy
npm run db:seed                                   # demo data; add `-w backend -- --profile test --reset` for a test DB
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/smartdesk_test npm run test:db
npm run docs:db                                   # regenerate erd.md and data-dictionary.md
```

`npm run test:db` creates a new uniquely named database (always containing "test") on the server in
`TEST_DATABASE_URL`, applies every migration, runs the integration suite and drops the database again.
To run the suite against an already migrated test database: `npm run test:integration -w backend`
with `TEST_DATABASE_URL` set (this is what CI does). Compose publishes no host port for PostgreSQL; use
a disposable container (`docker run -p 5432:5432 …`) or a `docker-compose.override.yml` for local test runs.

## Test matrix (all against real PostgreSQL)

| Entity / relationship                | Where it is covered                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `users`                              | `constraints` (roles, case-variant and duplicate email, blank name)                                       |
| `support_teams`, `ticket_categories` | `constraints` (duplicate and blank names)                                                                 |
| `team_members`                       | `constraints` (two teams OK; duplicate, missing team/user rejected)                                       |
| `tickets` new / triaged              | `constraints`, `schema` (defaults, blank text, invalid enums, missing triage fields)                      |
| `tickets` assignee                   | `constraints` (wrong team, other team, NULL team, membership removal, race)                               |
| `tickets` resolve / reopen           | `constraints` (resolution fields, stale resolution), `transactions` (invalid edges, reopen keeps history) |
| `ticket_comments`                    | `constraints`, `transactions` (public/internal, blank, orphan, employee limits)                           |
| `ticket_events`                      | `constraints` (type, object JSON, NULL actor, append-only, orphan)                                        |
| `ai_recommendations`                 | `constraints` (confidence, priority, review completeness, dates), `transactions` (immutable proposals)    |
| `knowledge_articles`                 | `constraints`                                                                                             |
| `recommendation_articles`            | `constraints` (duplicate pair, duplicate rank, rank ≤ 0)                                                  |
| `classification_labels`              | `constraints` (one per ticket, invalid FKs), `seed` (independent of AI)                                   |
| Historical FK / deletion             | `constraints` (restrict, deactivate), `schema` (all FKs RESTRICT)                                         |
| Atomicity                            | `transactions` (CHECK failure and injected throw leave nothing behind)                                    |
| Authorization / role scoping         | `operationalQueries`, `reports`, `transactions`, `dictionary` (employee-safe result shape)                |
| Concurrency                          | `constraints` (assignment vs membership removal), `transactions` (approvals, reviews)                     |
| Q01-Q10                              | `operationalQueries`, `reports` (hand-calculated fixtures, NULL denominators, empty windows)              |
| DDL vs documentation                 | `dictionary` (information_schema / pg_constraint / pg_index vs `schema-spec.json`)                        |
| Precision, UUID, JSONB, NUMERIC      | `dictionary` (microsecond UTC timestamps, UUID v4), `constraints` (NUMERIC(4,3), JSONB object)            |

Each name above is a file `backend/test/integration/<name>.integration.test.ts`.
