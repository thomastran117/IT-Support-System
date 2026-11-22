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
