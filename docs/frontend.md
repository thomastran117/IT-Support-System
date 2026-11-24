# Frontend UI conventions

One styling system: **Tailwind utilities plus the shared classes in `frontend/src/app/globals.css`**
(`app-card`, `app-field`, `app-button-*`, `app-table`, `app-badge`, `skeleton`). Do not add a second CSS
framework or component library, and do not re-create these primitives inside a feature folder.

## Where things live

| Need                                 | Use                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| App shell, role navigation, sign-out | `components/NavShell.tsx` (one shell for employee, technician, admin)                    |
| Page title block                     | `PageHeader` from `components/ui`                                                        |
| Buttons                              | `Button` / `buttonClass(variant)` (`primary`, `secondary`, `quiet`, `danger`)            |
| Status and priority                  | `StatusBadge`, `PriorityBadge` (always text, colour only reinforces)                     |
| Loading, empty, error                | `LoadingState`, `EmptyState`, `ErrorState`                                               |
| Inline message                       | `Notice` (`info`, `success`, `warning`, `danger`)                                        |
| Modal                                | `Dialog` (native `<dialog>`: focus trap, Esc, focus restore)                             |
| Transient feedback                   | `useToast().show(message, tone)`; never the only place a result appears                  |
| Form error summary, field, counter   | `components/tickets/ui.tsx` (`ErrorSummary`, `Counter`, `inputClass`)                    |
| Tables                               | `app-table`; add `responsive-table` and `data-label` on cells for the mobile card layout |

Import from `@/components/ui`. Feature components (`tickets/`, `technician/`, `knowledge/`, `admin/`,
`reports/`) compose these; anything used by a second feature moves into `components/ui`.

## Navigation

Entries per role are declared once in `NAVIGATION` in `NavShell.tsx`. A new page gets a nav entry there and
an `active` matcher that does not also match its siblings. Every page renders one `<h1>` via `PageHeader` and
exports `metadata.title` (the document title becomes `<title> · SmartDesk`). Sign-out is always visible in the
sidebar (desktop) and the navigation drawer (mobile).

## Colour, status and priority

- Status and priority are always rendered as words; the tone (see `badges.tsx`) is secondary.
- Pair text and background from the same family (`text-*-800` on `bg-*-50`) to keep AA contrast.
- `@media (forced-colors: active)` in `globals.css` keeps borders and focus outlines in high-contrast mode.
- No decorative animation. The only motion is the loading skeleton, disabled under `prefers-reduced-motion`.
- Do not show placeholder metrics: every number on screen comes from the API.

## Responsive rules

Pages must not scroll horizontally at 320-375 px. Wide tables use `responsive-table` (card layout below
768 px) or an explicit `overflow-x-auto` wrapper. Primary actions stay reachable at every width.

## Forms, tables and async states

Build forms from these pieces instead of hand-wiring labels, errors and pending states:

| Need                               | Use                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Label, hint, counter, error        | `FormField` (`components/forms`): sets `aria-invalid` and `aria-describedby` for you                                      |
| Error list after a failed submit   | `ErrorSummary` + `useFocusTarget()`: focus moves to the summary; each item links to its field                             |
| Submit button with pending state   | `AsyncButton` (disabled and relabelled while running)                                                                     |
| One submission at a time + failure | `useSubmit()` (`lib/forms`): blocks double submits and keeps the last failure                                             |
| Failure message and retry          | `SubmitError`: announces the failure; "Try again" only when `failure.retryable`; "Reload latest" for a stale record (409) |
| Confirm a disruptive action        | `ConfirmDialog` (focus starts on Cancel; Escape cancels). Never `window.confirm`                                          |
| Paged lists                        | `Pagination` (`offset`, `limit`, `count`, `total`, `nextOffset`)                                                          |

Rules:

- **Keep what the user typed.** State lives in the component, never in the submit hook, so a network
  failure, timeout, 5xx or 409 leaves the form as it was and a retry resends it.
- **`toFailure(err)` is the only place error text is chosen** for the shared pieces. It reads the
  `ApiError.kind` from the API client (see `docs/api.md`), so the same failure reads the same
  everywhere. Server validation (`fieldErrors`) supplements client checks; it never replaces them.
- **Errors are text, linked to the field, and announced.** `role="alert"` for failures,
  `role="status"` for progress.
- Extract a component only once a second feature needs it, and keep the employee ticket form's
  behaviour (draft restore, idempotency keys) in its own feature code.

## Ticket search

My tickets, the technician dashboard, and the admin Tickets page share one search panel. Type a
title, description, or tracking ID. Search starts after a short pause, and Enter submits immediately.
The panel cancels superseded requests and keeps the search text, filters, and page in the URL.
Result links carry that state into ticket details so users can return to the same search.

Status, priority, category, and UTC creation dates are available to all roles. Technicians can
filter by their active teams or their own assignment, and admins can select teams and assignees.
Both dates in the form are inclusive. Clear search returns to the ordinary ticket list or support
queue. Reset filters keeps the search text and returns to the first page.

Text search labels PostgreSQL results when OpenSearch is disabled, behind, or unavailable. During
an outage, a page started on OpenSearch offers a first-page restart. Full tracking IDs use
PostgreSQL. The list sorts newest first, and the team and assigned queues sort by priority.

The frontend GitHub workflow exercises search using a disposable PostgreSQL and OpenSearch stack,
then stops OpenSearch to exercise the outage flow. On Linux, run the same Playwright scenarios
through the CI image with `sh docker/verify-ticket-search-browser.sh <frontend-ci-image>`.
