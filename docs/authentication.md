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

## Internal service authentication

The gateway forwards the browser's `Authorization` header and strips reserved identity headers
with the `X-SmartDesk-Internal-`, `X-Internal-`, `X-Actor-`, `X-User-`, and `X-Service-`
prefixes. Internal routes use `/internal/*` and stay outside the gateway's public route table.
Each receiving service verifies credentials on its own listener, including requests originating
from the private network.

### Service credentials and delegated users

An internal caller sends an ES256 JWT as `Authorization: Bearer <service-token>`. Each caller
keeps its own P-256 signing key. The receiving service pins a public key, caller name, and
grants to each configured `kid`.

| JWT field        | Value                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Protected header | `alg` is `ES256`, `typ` is `smartdesk-service+jwt`, and `kid` selects the configured caller key                                      |
| `iss` and `sub`  | `smartdesk-internal` and the exact configured caller service name                                                                    |
| `aud`            | One receiving service. Ticket uses `smartdesk-ticket`, Identity uses `smartdesk-identity`, and Knowledge uses `smartdesk-knowledge`. |
| `iat` and `exp`  | Integer UTC epoch seconds. Issue for at most 60 seconds and keep service clocks synchronized.                                        |
| `scope`          | One operation allowed both by the endpoint and by the caller's grant                                                                 |
| `actor`          | `{ "kind": "system" }` or `{ "kind": "user", "tokenHash": "<base64url SHA-256>" }`                                                   |

For a delegated call, send the user's existing access JWT in `X-SmartDesk-Internal-User-Token`.
Hash the exact token bytes without a `Bearer` prefix and encode the digest as unpadded base64url
for `actor.tokenHash`. The receiver verifies the binding, validates the access JWT with the same
checks as the public API, and loads current account status, token version, role, and active teams
from PostgreSQL. The owning service applies the relevant resource policy. System operations
require an explicit system grant and carry only the authenticated service identity.

`GET /internal/tickets/:id/work-access` requires a `ticket:work-access` user grant. It returns
`204` when the delegated user can edit that ticket under the existing Ticket policy. Missing or
invalid credentials return `401`, ineligible actors or scopes return `403`, and tickets outside
the user's read scope return `404`. The decision applies to the current request. A later
mutation must authorize again within its owning workflow.

Use authenticated TLS for internal traffic in production. Carry credentials only in headers and
correlate calls using request IDs. The backend redacts both credential headers from structured
request logs. A service JWT remains a bearer credential during its short lifetime.
[JWT best practices](https://www.rfc-editor.org/rfc/rfc8725.html)

### Configure and rotate keys

Set `INTERNAL_SERVICE_KEYS` on the receiving backend to a JSON array of entries like this one.
Substitute the caller's P-256 public key in PEM-encoded SPKI form.

```json
[
  {
    "kid": "workflow-v1",
    "service": "workflow",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n<public key>\n-----END PUBLIC KEY-----",
    "grants": { "ticket:work-access": "user" }
  }
]
```

Store private signing keys with the respective caller. Rotate a caller by adding the new
public key with a fresh `kid` and the same grants. Restart receivers with both keys, switch the
caller to the new signing key, then remove the old entry after its last token expires and
restart the receivers again. Remove a compromised key immediately and restart receivers to
revoke trust.

The registry defaults to empty. To disable internal routes, clear the registry and recreate
the backend. The [direct API rollback override](../README.md#switch-back-to-the-direct-api) also
clears the registry before exposing the backend listener. Public login, refresh, logout, and
account revocation continue to use the existing session model.

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

## Knowledge base access

Article visibility is independent of ticket scope: being able to work a ticket grants nothing on
drafts. Publication state, not role, decides what a reader sees; only administrators write.

| Surface                                         | Anonymous | Employee  | Technician | Administrator   |
| ----------------------------------------------- | --------- | --------- | ---------- | --------------- |
| List / search / read a **published** article    | 401       | Yes       | Yes        | Yes             |
| List / search / read a **draft or unpublished** | 401       | 404, none | 404, none  | 404, none       |
| `/api/admin/knowledge` read (incl. drafts)      | 401       | 403       | 403        | Yes             |
| Create, edit, publish, unpublish                | 401       | 403       | 403        | Yes             |
| Delete                                          | none      | none      | none       | none (no route) |
| AI retrieval (`searchPublished`)                | n/a       | n/a       | n/a        | published only  |

Safe failure rules, all enforced in the query or guard and asserted by
`knowledge*.integration.test.ts` against PostgreSQL:

| Threat                                                              | Control                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Reading a draft by guessing its id                                  | `is_published` in the query; response is identical to an unknown id (no title, body or id echo) |
| Finding a draft through search or the list                          | Partial index and every query filter published rows; swept over every word of every article     |
| AI retrieval bypassing the reader endpoint                          | One repository function (`searchPublished`), used by the endpoint and the service AI will call  |
| Probing draft ids through admin status codes                        | Admin routes answer 403 to non-admins before any lookup, whether or not the id exists           |
| Non-admin writes (including `PUT`/`DELETE`/`isPublished` smuggling) | Role guard; strict schemas reject unknown fields; reader surface has no write routes            |
| Partial updates from invalid input                                  | Validation first, then one `UPDATE`; invalid category or field leaves the row untouched         |
| Stale or revoked tokens, deactivated accounts                       | Guard re-reads the account (`isActive`, `tokenVersion`) on every request: 401                   |
| Query-string attacks (quotes, SQL, wildcards, Unicode)              | Bound parameter into `websearch_to_tsquery`; `LIKE` wildcards are not special; length capped    |
| Markup in articles                                                  | Stored inert; JSON responses only; clients must render escaped                                  |

## Administrator safeguards

Accounts are deactivated rather than deleted so ticket and audit history retain their references.
Administrators cannot change their own role, deactivate themselves, reset their own password, or
remove the last active administrator. Account creation and password reset return a random temporary
password once with `Cache-Control: no-store`; only its hash is persisted.

The administrator audit log is append-only and excludes credentials and token state. API logging
redacts authorization, cookies, set-cookie headers, passwords, access tokens, and configured content
fields.

## Demo accounts

Once the default Compose stack is ready, load the demo accounts and sample tickets.

```bash
docker compose run --rm --no-deps local-bootstrap npm run db:seed
```

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
