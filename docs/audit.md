# Ticket audit trail

Every material change to a ticket writes an immutable event to `ticket_events` in the **same database
transaction** as the change itself (SD-022). If either fails, both roll back: there is never a change
without its event, nor an event for a change that did not happen.

## Rules

- **One writer.** Events are only written by `appendEvent` (`backend/src/db/repositories/ticketEvents.ts`).
  A unit test fails if any other source file inserts into `ticket_events`. (Bulk-loading fixtures in the
  seed is the single exception.)
- **Sanitized by construction.** `appendEvent` reduces `details` to the allow-listed keys for the event
  type (`backend/src/domain/ticketEvents.ts`): ids, statuses, priorities, and flags. Passwords, hashes,
  tokens, comment text, ticket titles and descriptions have no way in, whatever a caller passes. Reads
  sanitize again, so even a stray legacy row cannot leak.
- **Immutable.** A database trigger rejects UPDATE and DELETE on `ticket_events` for every role, and
  the API has no route to add, edit or delete an event (tested for POST, PUT, PATCH and DELETE).
- **Ordered.** `occurred_at` is the database `clock_timestamp()`, so events written in one transaction
  keep their order; reads sort by `(occurred_at, event_id)`, a total order.
- **Actor.** The acting user's id, or `NULL` for a system action (such as an automatic close).

## Event types

The canonical list is `TICKET_EVENT_TYPES` in `packages/contracts`. The database CHECK
`ck_ticket_events_type` must list exactly the same values; a test compares them. To add a type: extend
that list, add a migration for the CHECK, and describe its details in `domain/ticketEvents.ts`.

| Type               | Written when                                  | Details (allow-listed)                     | Requester sees         |
| ------------------ | --------------------------------------------- | ------------------------------------------ | ---------------------- |
| `CREATED`          | ticket submitted                              | none                                       | yes                    |
| `STATUS_CHANGED`   | a status transition other than resolve/reopen | `from`, `to`                               | yes, with `from`, `to` |
| `RESOLVED`         | moved to RESOLVED                             | `from`                                     | yes                    |
| `REOPENED`         | moved from RESOLVED/CLOSED back to OPEN       | `from`                                     | yes                    |
| `TEAM_ASSIGNED`    | the first team is approved                    | `from` (null), `to` (team id)              | yes, no details        |
| `TEAM_REASSIGNED`  | the team changes later                        | `from`, `to` (team ids)                    | yes, no details        |
| `CATEGORY_UPDATED` | the approved category changes                 | `from`, `to` (category ids)                | yes, no details        |
| `PRIORITY_UPDATED` | the approved priority changes                 | `from`, `to` (priorities)                  | yes, with `from`, `to` |
| `ASSIGNEE_UPDATED` | the assignee changes                          | `from`, `to` (user ids)                    | no                     |
| `COMMENT_ADDED`    | a comment is posted (public or internal)      | `commentId`, `isInternal`, `firstResponse` | no                     |
| `AI_REVIEWED`      | a technician decides on an AI recommendation  | `recommendationId`, `decision`             | no                     |

Why requesters do not see some types: `COMMENT_ADDED` would reveal that an internal note exists (public
comments are already in the conversation); `AI_REVIEWED` and `ASSIGNEE_UPDATED` are internal staffing.
Team and category changes show that they happened, not which record, and requesters never see actors.

## Coverage checklist

Each ticket mutation, the events it writes, and the test that proves it. Add a row when a new
mutation is introduced; a mutation without a row here is not done.

| Mutation (service)                              | Events                                                                                                                                                   | Proven by                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `submitTicket` (`POST /api/tickets`)            | `CREATED`                                                                                                                                                | `tickets.integration`, `ticketEvents.integration` (lifecycle)                |
| `approveRouting` (E04 will expose it over HTTP) | `CATEGORY_UPDATED`, `PRIORITY_UPDATED`, `TEAM_ASSIGNED`/`TEAM_REASSIGNED`, `ASSIGNEE_UPDATED`, `STATUS_CHANGED` (OPEN to TRIAGED when routing completes) | `ticketEvents.integration` (lifecycle, rollback), `transactions.integration` |
| `transitionTicket` (`POST .../transitions`)     | `STATUS_CHANGED`, `RESOLVED`, `REOPENED`                                                                                                                 | `ticketTransitions.integration`, `ticketEvents.integration`                  |
| `addComment` (`POST .../comments`)              | `COMMENT_ADDED`                                                                                                                                          | `ticketComments.integration`, `ticketEvents.integration`                     |
| `reviewRecommendation` (E04/E06 will expose it) | `AI_REVIEWED` and any routing events it applies                                                                                                          | `ticketEvents.integration` (lifecycle, rollback), `transactions.integration` |
| System actions (actor `NULL`)                   | the same types                                                                                                                                           | `ticketEvents.integration` (system action shown to staff as `null`)          |

For each row, the tests check that the event exists with the right actor, details and order, and that a
forced failure of the event write rolls the change back.

## Reading the timeline

`GET /api/tickets/:id/events` (see `docs/api/tickets.md`). Staff in scope (admin, or a technician in
the ticket's team or the unrouted backlog) get every event with its actor. Everyone else, including the
requester and a technician who raised the ticket outside their scope, gets the reduced view above. The
ticket detail's `timeline` is the same list.
