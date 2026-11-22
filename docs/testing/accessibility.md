# Accessibility and responsive checks

Target: practical WCAG 2.2 level AA for every screen a user reaches in the three portals. The checks
below run in CI (`frontend/e2e/a11y.spec.ts`) against the production build with the mocked API, so
they are deterministic and do not need the backend.

## What is checked automatically

| Check                | How                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WCAG A/AA rules      | axe (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) on all 17 screens, at the desktop and phone (Pixel 7) viewports. Any violation, whatever its impact, fails the test.                 |
| Page structure       | Each screen has exactly one `<h1>`, one `main` landmark and a non-empty document title.                                                                                                           |
| Responsive layout    | At 320, 375 and 768 px: no horizontal page scroll, and no button, link or field is pushed past the right edge (wide tables scroll inside their own labelled, focusable region).                   |
| Keyboard only        | Sign in; skip link; submit a ticket (validation first, focus moves to the error summary); technician approves routing; admin reaches Reports through the navigation; dialog focus; visible focus. |
| Focus in dialogs     | Opening a confirmation focuses Cancel, Tab never reaches the page behind it, Escape closes it and focus returns to the control that opened it.                                                    |
| Status not by colour | Status and priority are always text (`StatusBadge`, `PriorityBadge`); the visual baselines and unit tests cover the labels.                                                                       |

Screens covered: login; employee tickets, new ticket, ticket detail, knowledge search and article;
technician queue, triage and knowledge; admin users, categories, teams, reports, AI evaluation, and
the article list, new and edit pages.

## Issues found and fixed in SD-052

- The brand link had an `aria-label` that did not contain its visible text, so voice-control users
  could not say what they saw (WCAG 2.5.3). The name now comes from the visible content.
- The "Showing a–b of n" text used `slate-500` on the page background (below 4.5:1); it is now `slate-600`.
- Horizontally scrolling regions (article table, report tables, code samples) were not reachable by
  keyboard (WCAG 2.1.1). They are now focusable regions with an accessible name.

## Manual checklist (run before a release)

Automated rules find roughly a third of accessibility problems. These were **not** run as part of
SD-052 and are the known gap:

- [ ] Screen reader pass (NVDA + Firefox or VoiceOver + Safari) of sign-in, new ticket, triage and
      the report page: headings read in order, errors are announced, table captions make sense.
- [ ] 200% browser zoom and 400% reflow at 1280 px wide (320 CSS px): no lost content or controls.
- [ ] Windows High Contrast / forced colours: badges, focus rings and borders remain visible
      (the stylesheet has a `forced-colors` block; it has not been inspected visually).
- [ ] Text spacing override bookmarklet: nothing clipped.
- [ ] Charts and report visuals: confirm each has a text equivalent when new chart types are added.

## Adding a screen

1. Add it to `SCREENS` in `a11y.spec.ts`; it then gets the axe, structure and width checks for free.
2. Give it one `<h1>` (via `PageHeader`) and a `metadata.title`.
3. Build forms from `components/forms` (see `docs/frontend.md`) so labels, errors and focus behave the same.
4. Wrap any wide table in a region with `tabIndex={0}` and an `aria-label`, or use `responsive-table`.

## Known limitations

- The e2e suite uses mocked API responses, so these checks do not exercise real data volumes (very
  long titles, many rows). A real-API smoke flow is not part of this suite; the Compose `ci` profile
  does not start the backend for the browser tests.
- axe cannot judge the quality of alternative text, reading order or whether an error message is
  understandable; the manual checklist above covers those.
