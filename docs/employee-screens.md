# Employee ticket screens

Implemented in `frontend/src/app/(employee)` and `frontend/src/components/tickets` (SD-023). Every
screen talks to the real API (`/api/tickets`, see [api/tickets.md](api/tickets.md)); there is no sample
data. Only the `EMPLOYEE` role reaches these routes (`RequireRole`); the API enforces ownership
independently, so another employee's ticket is a 404 whatever the URL.

## Routes

| Route                    | Screen                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| `/employee`              | **My tickets**: own tickets, newest first, status and priority filters, paging   |
| `/employee/tickets/new`  | **New ticket**: submission form                                                  |
| `/employee/tickets/[id]` | **Ticket**: tracking ID, progress, approved fields, conversation, reply, history |

The navigation bar shows "My tickets" and "New ticket" to employees.

## Submitting

- The form validates with `createTicketSchema` from `@smartdesk/contracts`, **the same object the API
  uses**, so the limits (title 1-150, description 1-5000, trimmed, nonblank) cannot drift apart. Messages
  are written for people ("Title must be 150 characters or fewer."); counters show length against the limit.
- Failed validation never reaches the server. An **error summary** receives focus (`role="alert"`), each
  message links to its field, and fields carry `aria-invalid` and `aria-describedby`.
- **Nothing is lost on failure.** The text stays in the form after a server or network error, and an
  unsent draft is kept in `sessionStorage` per user, so a reload or an expired session does not discard it.
  It is cleared on success. (Storage being unavailable is tolerated.)
- **No duplicates.** Each submission sends an `Idempotency-Key`. Retrying the same content, including after
  a lost response, reuses the key so the server returns the first ticket (200) instead of creating another;
  changed content gets a new key. A double click submits once.
- On success the browser goes to the ticket with a confirmation that shows the full tracking ID.

## Reading a ticket

- **Progress** is an ordered list (Open, Triaged, In progress, Resolved, Closed) with `aria-current="step"`
  and "Done / Current / Not yet" text, so state is never conveyed by colour alone. A reopened ticket goes
  back to Open.
- **Approved fields** (category, support team, priority, technician) show "Not set yet" until a technician
  approves them. A resolution summary appears once resolved.
- **Conversation** shows public replies only (the API never sends internal notes). The employee can reply
  with the same validation as the API; a failed reply keeps its text.
- **History** is the requester view of the timeline (`GET /api/tickets/:id/events` rules, see
  [audit.md](audit.md)): plain sentences, no actors, no record ids.

## Staying current

An open ticket re-checks the server every 15 seconds (`NEXT_PUBLIC_TICKET_POLL_MS`, minimum 1000, falling
back to 15000 for anything invalid) and again whenever the tab becomes visible; a hidden tab does no work.
A status change is announced through a polite live region. If a check fails the page keeps what it shows
and says updates are paused, with a "Check again" button. Responses are ordered, so a slow older response
never overwrites a newer one.

## States and layout

Each list and detail has loading, empty, error (with retry) and not-found states. Tables scroll inside
their own container, text wraps (including long tracking IDs), and no screen scrolls the page sideways at
phone width. Everything is reachable and operable by keyboard; focus rings are visible.

## Tests

- Unit (`frontend/test/unit/tickets.test.ts`): validation against the shared schema, submission keys,
  drafts (including broken storage), event and error wording, the API wrappers, the poll setting.
- End to end (`frontend/e2e/employee.spec.ts`, desktop and mobile, against a mocked API in
  `frontend/e2e/helpers/mockApi.ts`): the full journey (sign in, submit, find, open, reply, then a
  simulated technician triages, replies publicly and leaves an internal note, and the open page updates
  without a reload with the note never appearing); isolation from another employee's ticket; the error
  summary and its links; draft and idempotency across a 500 and a dropped connection; double click;
  paging, filters and error recovery; offline refresh handling; no horizontal overflow.

The mock follows the server rules (ownership, the requester timeline, idempotent create), but it is a
model: the real API is covered by the backend integration tests.
