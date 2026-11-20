# Seed fixtures

Deterministic synthetic data for all eleven core tables (SD-009). No real people, passwords, tokens
or API secrets. Source: `backend/src/db/seed/fixtures.ts`; entry point `backend/prisma/seed.ts`.

## Commands (npm workspaces)

```bash
npm run db:migrate                                        # apply migrations
npm run db:seed                                           # demo profile (default)
npm run db:seed -w backend -- --profile test              # minimal profile with exact expectations
npm run db:seed -w backend -- --profile test --reset      # empty a *test* database first
```

- Every insert is `ON CONFLICT DO NOTHING`: re-running changes nothing (verified by the seed test,
  which hashes `ticket_events` before and after). Existing rows are never updated, because
  `ticket_events` is append-only.
- `--reset` is refused unless the database name contains `test`.
- Docker: `docker compose exec backend npm run db:seed -w backend`.
- Demo credentials are not seeded; hashed credentials arrive with the auth schema (SD-013, #25).

## Profiles

- **test**: the data below. Report results are asserted exactly (`EXPECTED` in `fixtures.ts`).
- **demo**: `test` plus two OPEN tickets (Wi-Fi, PDF editor, created 2026-03-10/11) and two published
  articles. Row counts: tickets 12, ticket_events 42, knowledge_articles 7; other tables unchanged.

## Row counts (test profile)

| Table                   | Rows | Notes                                                                    |
| ----------------------- | ---- | ------------------------------------------------------------------------ |
| users                   | 8    | 1 admin, 3 employees (1 inactive), 4 technicians (1 inactive)            |
| support_teams           | 3    | Network & Access, Hardware & Devices, Legacy Desk (inactive)             |
| team_members            | 5    | Tom is in two teams; Ingrid in the inactive team                         |
| ticket_categories       | 5    | Hardware, Software, Network/VPN, Access/Accounts, Legacy (inactive)      |
| tickets                 | 10   | see below                                                                |
| ticket_comments         | 6    | 5 public (incl. first technician response on the VPN ticket), 1 internal |
| ticket_events           | 40   | 34 workflow events + 6 `COMMENT_ADDED`; one NULL-actor system event      |
| ai_recommendations      | 6    | PENDING x2, ACCEPTED x2, OVERRIDDEN, REJECTED                            |
| knowledge_articles      | 5    | 4 published, 1 draft                                                     |
| recommendation_articles | 4    | ranks 1 and 2 on the VPN recommendation                                  |
| classification_labels   | 5    | 2 correct AI predictions, 2 incorrect, 1 ticket with no AI result        |

## Tickets (all times UTC)

| Key         | Status      | Created        | Requester | Team / assignee | Notes                                                                                     |
| ----------- | ----------- | -------------- | --------- | --------------- | ----------------------------------------------------------------------------------------- |
| printer     | OPEN        | 03-02 09:00    | Erin      | none            | unassigned, UNSET, PENDING recommendation                                                 |
| vpn         | TRIAGED     | 03-02 14:00    | Erin      | Network, none   | routed 14:30; ACCEPTED rec; second (re-analysis) PENDING rec at 15:00                     |
| license     | IN_PROGRESS | 03-03 10:00    | Omar      | Network, Tom    | routed to Hardware 10:10, reassigned to Network 11:00; OVERRIDDEN rec                     |
| password    | RESOLVED    | 03-04 08:00    | Erin      | Network, Tara   | routed 08:30; resolved 03-04 16:00 (8 h); ACCEPTED rec                                    |
| monitor     | CLOSED      | 03-05 09:00    | Omar      | Hardware, Hana  | routed 09:15; resolved 03-06 09:00 (24 h); closed by system 03-20; REJECTED rec           |
| reopened    | OPEN        | 03-06 11:00    | Erin      | Network, none   | routed 11:20, resolved 03-07, reopened 03-08; resolution fields NULL, RESOLVED event kept |
| aiDown      | OPEN        | 03-09 13:00    | Omar      | none            | AI unavailable: no recommendation, but labelled                                           |
| token       | OPEN        | 03-09 15:00    | Erin      | none            | same day as aiDown (Q10)                                                                  |
| boundary    | IN_PROGRESS | 03-01 00:00:00 | Omar      | Hardware, Hana  | exactly at window start; routed 00:45                                                     |
| afterWindow | OPEN        | 04-01 00:00:00 | Erin      | none            | exactly at window end (excluded from March)                                               |

Labels (by the admin evaluator, independent of AI): vpn=Network/VPN, license=Software,
password=Access/Accounts, monitor=Hardware, aiDown=Access/Accounts. First AI proposals: vpn Network/VPN
(correct), license Hardware (wrong), password Access/Accounts (correct), monitor Software (wrong).

## Expected results, window [2026-03-01, 2026-04-01)

- **Q03** unassigned backlog (OPEN, no team): printer, aiDown, token, afterWindow.
- **Q05**: submitted 9 (all but afterWindow); routed 6 (vpn 30 min, license 10, password 30, monitor 15,
  reopened 20, boundary 45 → 150 / 6) → `avg_minutes = 25.00`. License uses its _first_ routing (10:10),
  not the reassignment.
- **Q06**: resolved_tickets 2 (password 8 h, monitor 24 h) → `avg_hours = 16.00`. The reopened ticket is excluded.
- **Q07**: labelled 5, with recommendation 4, correct 2 → `accuracy_pct = 40.00`. The vpn re-analysis
  recommendation is ignored (first recommendation only); aiDown counts as incorrect.
- **Q08**: reviewed 4 (vpn, license, password, monitor), accepted 2 → `acceptance_pct = 50.00`. PENDING excluded.
- **Q09**: Uncategorized 3, Hardware 2, Software 2, Access/Accounts 1, Network/VPN 1.
- **Q10**: 03-01: 1, 03-02: 2, 03-03: 1, 03-04: 1, 03-05: 1, 03-06: 1, 03-09: 2 (no rows for other days).
- **Empty window** [2026-05-01, 2026-06-01): every count 0 and every mean/percentage NULL.
