# Required SQL queries

Version-controlled SQL under `backend/sql/`, called through typed repository methods. All values are
bound parameters; the SQL files are static and never built from user input. Tests:
`backend/test/integration/*Queries.integration.test.ts`, run against the seeded `test` profile
(expected values in [fixtures.md](./fixtures.md)).

## Operational queries Q01-Q04 (`backend/sql/queries/`, SD-010)

Repository: `backend/src/db/repositories/operationalQueries.ts`. Every method re-reads the acting user
(must exist and be active), checks scope, then runs the stored SQL. Pagination appends bound
`LIMIT/OFFSET` after the original `ORDER BY` (default 50, maximum 100, offset >= 0), so documented
ordering and tie-breakers are unchanged.

| Query | File                                                                     | Parameters                  | Result columns                                                                       | Method                                      |
| ----- | ------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| Q01   | `Q01_employee_ticket_history.sql`                                        | `$1` caller's user UUID     | `ticket_id, title, status, priority, created_at, updated_at`                         | `listEmployeeTickets(prisma, actorId)`      |
| Q02   | `Q02_team_queue.sql`                                                     | `$1` authorized team UUID   | `ticket_id, title, priority, status, assignee_id, created_at`                        | `listTeamQueue(prisma, actorId, teamId)`    |
| Q03   | `Q03_unassigned_backlog.sql`                                             | none                        | `ticket_id, title, priority, created_at, age_minutes` (minutes, DB clock, `numeric`) | `listUnassignedBacklog(prisma, actorId)`    |
| Q04   | `Q04_ticket_audit.sql` (staff), `Q04_ticket_audit_requester.sql` (owner) | `$1` authorized ticket UUID | `event_type, occurred_at, actor (display name or NULL), details (jsonb)`             | `getTicketAudit(prisma, actorId, ticketId)` |

Ordering: Q01 `created_at DESC, ticket_id`; Q02 CRITICAL, HIGH, MEDIUM, LOW, then UNSET, then
`created_at, ticket_id`; Q03 `created_at, ticket_id`; Q04 `occurred_at, event_id`. No matching rows
returns an empty array (never an error).

### Authorization (enforced in the repository, not trusted from the URL)

- **Q01**: the id comes from the authenticated session; there is no way to ask for another user's list.
- **Q02**: admins any team; technicians only teams they are a member of; employees and inactive users
  are refused (`FORBIDDEN`).
- **Q03**: technicians and admins (all unassigned tickets); employees refused.
- **Q04**: admins any ticket; technicians tickets of their team or unassigned tickets; the requester
  their own ticket via the restricted variant. Anyone else gets `NOT_FOUND`, identical to a missing
  ticket, so ids cannot be probed.

### Documented deviations from the Deliverable 2 SQL

1. Q01-Q04 are unchanged apart from a leading comment block and the appended pagination.
2. **`Q04_ticket_audit_requester.sql`** is an added variant, not a change to Q04. For the ticket owner
   it returns only `CREATED`, `STATUS_CHANGED`, `RESOLVED`, `REOPENED` and public `COMMENT_ADDED`
   events (internal notes excluded), and reduces `details` to `{from, to}` for status changes and `{}`
   otherwise. Team routing, AI review payloads and system reasons (e.g. auto-close) are therefore never
   shown to employees.
3. `age_minutes` is computed from `NOW()` when the query runs, so it differs between runs. Tests assert
   it against the current time with a tolerance.

## Reporting and AI-evaluation queries Q05-Q10 (`backend/sql/reports/`, SD-011)

Repository: `backend/src/db/repositories/reports.ts`, available to **active administrators only**
(evaluator = admin). Every method takes `{ start, end }` (JS `Date`, bound as `timestamptz`):
windows are half-open `[start, end)`, UTC, and `start` must be strictly before `end`
(`VALIDATION` otherwise). Only aggregates are returned: no ticket text, ids or comments.
Counts are numbers (`0` for an empty cohort); undefined means and percentages are `null`, never `0`
(`NULLIF` in the SQL). Results are rounded to 2 decimals by the SQL.

| Query | File                                | Window applies to    | Result                                                         | Unit / meaning                                                                                                                        |
| ----- | ----------------------------------- | -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Q05   | `Q05_avg_time_to_first_routing.sql` | ticket `created_at`  | `submitted, routed, avg_minutes`                               | minutes from creation to the **first** `TEAM_ASSIGNED`; reassignments never replace it; unrouted stay in `submitted`                  |
| Q06   | `Q06_avg_time_to_resolution.sql`    | ticket `resolved_at` | `resolved_tickets, avg_hours`                                  | hours from creation to the **latest** resolution of tickets currently RESOLVED/CLOSED; reopened tickets excluded until resolved again |
| Q07   | `Q07_ai_category_accuracy.sql`      | ticket `created_at`  | `labelled_tickets, with_recommendation, correct, accuracy_pct` | first saved recommendation vs independent reference label; missing recommendation or NULL category = incorrect                        |
| Q08   | `Q08_ai_acceptance_rate.sql`        | `reviewed_at`        | `reviewed, accepted, acceptance_pct`                           | ACCEPTED / reviewed; OVERRIDDEN and REJECTED count against; PENDING excluded. Acceptance is not accuracy                              |
| Q09   | `Q09_recurring_categories.sql`      | ticket `created_at`  | rows of `category, ticket_count`                               | current approved category; `Uncategorized` for NULL; ordered by count desc then name                                                  |
| Q10   | `Q10_daily_ticket_intake.sql`       | ticket `created_at`  | rows of `report_date, submitted_tickets`                       | UTC calendar date; days without tickets are omitted (gap filling is a presentation concern)                                           |

TypeScript methods: `reportRoutingTime`, `reportResolutionTime`, `reportAiAccuracy`, `reportAiAcceptance`,
`reportRecurringCategories`, `reportDailyIntake` (camelCase result fields).

### Documented limitations

- **First vs latest**: routing uses the first `TEAM_ASSIGNED`; resolution uses the latest `resolved_at`.
  A ticket resolved, reopened and not yet resolved again is absent from Q06.
- **What counts as an AI response (Q07)**: the earliest saved `ai_recommendations` row for the ticket
  (`created_at, recommendation_id`), whatever its review status. A failed analysis is not stored, so it
  appears as a missing recommendation. A later re-analysis never changes the result.
- **Sample size**: report `labelled_tickets` / `submitted` / `reviewed` next to every percentage and
  state the observation window; do not claim the 90 % accuracy target without running the evaluation.
- **Success criteria**: the 50 % routing-time reduction is
  `(manual_baseline_mean - SmartDesk_mean) / manual_baseline_mean * 100`; the manual baseline is a
  separate controlled measurement and is not produced by Q05.
- **Q10** returns one row per day with tickets; an unbounded window returns one row per active day.
- Q05-Q10 are executed unchanged from Deliverable 2 apart from explanatory comment headers.

### Verified results (test fixtures, March 2026)

Q05 9 / 6 / 25.00 min, Q06 2 / 16.00 h, Q07 5 / 4 / 2 / 40.00 %, Q08 4 / 2 / 50.00 %, Q09
Uncategorized 3, Hardware 2, Software 2, Access/Accounts 1, Network/VPN 1, Q10 7 days (see
[fixtures.md](./fixtures.md) for the arithmetic). Tests also cover empty windows, unlabelled and
unrouted cohorts, reopened tickets, reassignments, review outcomes and inclusive-start / exclusive-end
boundaries.
