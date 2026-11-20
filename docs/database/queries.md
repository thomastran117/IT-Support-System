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
