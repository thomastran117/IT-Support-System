# Authentication and authorization

SmartDesk uses short-lived signed access tokens and a longer-lived refresh token. Passwords are
stored only as Argon2id hashes; inactive or credential-less accounts cannot sign in.

## Session model

- Login returns the access token in JSON and sets `sd_refresh` as an HttpOnly, `SameSite=Strict`
  cookie scoped to `/api/auth`.
- The frontend stores the access token in memory only. It is never written to browser storage,
  cookies, URLs, or logs.
- On reload, the frontend calls `/api/auth/refresh`. Concurrent 401 responses share one refresh and
  each request is retried at most once.
- Refresh tokens rotate on every successful refresh. Refresh and logout verify the browser `Origin`
  against `FRONTEND_ORIGIN` as CSRF protection.
- Access and refresh tokens include the user's `token_version`. Role changes, password resets, and
  deactivation increment that value and invalidate every outstanding token.
- Logout clears the refresh cookie. Because tokens are otherwise stateless, an already-issued access
  token remains valid until its short expiry unless `token_version` changes.

`JWT_SECRET` must be a random value of at least 32 characters in production. The Compose default is
development-only. `COOKIE_SECURE` should be true behind HTTPS.

## Roles and ticket scope

| Capability                       | Employee                    | Technician                                     | Administrator |
| -------------------------------- | --------------------------- | ---------------------------------------------- | ------------- |
| Read tickets                     | Own requests                | Own, active-team, and unrouted backlog tickets | All           |
| Work or transition tickets       | Reopen own resolved tickets | Active-team and unrouted backlog tickets       | All           |
| Add public comments              | Readable tickets            | Readable tickets                               | All           |
| Read/add internal notes          | Never                       | Tickets in work scope                          | All           |
| Manage users and admin audit log | Never                       | Never                                          | Yes           |

Technicians cannot gain work access merely by being the requester. The API checks current account
state, role, team membership, and record scope on every request; frontend route guards are not a
security boundary.

## Administrator safeguards

Accounts are deactivated rather than deleted so ticket and audit history retain their references.
Administrators cannot change their own role, deactivate themselves, reset their own password, or
remove the last active administrator. Account creation and password reset return a random temporary
password once with `Cache-Control: no-store`; only its hash is persisted.

The administrator audit log is append-only and excludes credentials and token state. API logging
redacts authorization, cookies, set-cookie headers, passwords, access tokens, and configured content
fields.

## Demo accounts

Run `docker compose exec backend npm run db:seed`. Active seeded accounts include:

| Role       | Email                  |
| ---------- | ---------------------- |
| Admin      | `admin@smartdesk.test` |
| Employee   | `erin@smartdesk.test`  |
| Technician | `tara@smartdesk.test`  |

All seeded accounts use the synthetic password `SmartDesk-Demo-1!`. These identities and credentials
are public development fixtures and must never be reused outside the local demo environment.

## Deployment constraints

The browser calls the API directly with credentials and the refresh cookie is `SameSite=Strict`.
Frontend and API therefore need to be on the same site, such as two subdomains of one registrable
domain. Deployments across unrelated domains require a same-origin proxy or a revised cookie/CSRF
design.
