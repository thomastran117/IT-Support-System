# Authentication design (epic E02)

Authentication is **stateless JWT**. The original E02 issues described server-side refresh sessions
(hashed refresh-token table, rotation, reuse detection); that was amended to stateless tokens, and
this page records what that means. Implementation lands issue by issue: SD-013 (this schema), then
SD-014 to SD-017.

## Model

| Piece                 | Design                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password storage      | Argon2id, `m=19456 KiB, t=2, p=1`, random salt per hash, PHC string in `users.password_hash` (`backend/src/auth/password.ts`).                                            |
| Access token          | HS256 JWT, 15 min (`ACCESS_TOKEN_TTL_SECONDS`), sent as `Authorization: Bearer`. Claims: `sub`, `tv`, `kind`, issuer, audience.                                           |
| Refresh token         | HS256 JWT, 7 days (`REFRESH_TOKEN_TTL_SECONDS`), in the `sd_refresh` cookie: HttpOnly, SameSite=Strict, Path=`/api/auth`, Secure in production. Not stored in PostgreSQL. |
| Revocation            | `users.token_version`, copied into every token. Increment it and every outstanding token for that user stops working.                                                     |
| Per-request authority | The server re-reads role, `is_active`, `token_version` and team membership from the database (SD-015); claims are not trusted for authorization.                          |

Only salted password hashes exist in PostgreSQL. A user with `password_hash IS NULL` has no credential
and cannot sign in. There is no public signup; accounts are seeded or created by an administrator
(SD-017).

## Endpoints (SD-014)

| Endpoint                 | Behaviour                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`   | Body `{email, password}`. Returns `{accessToken, expiresIn, user}` plus the refresh cookie. Wrong password, unknown, inactive or credential-less users all get the same 401 and cost one hash check. |
| `POST /api/auth/refresh` | Reads the cookie, reloads the user, requires active and matching `token_version`. Returns a new access token and re-issues the cookie (sliding 7 days). Failure: 401 and the cookie is cleared.      |
| `POST /api/auth/logout`  | Clears the cookie. Idempotent.                                                                                                                                                                       |
| `GET /api/auth/me`       | Requires a valid access token. Returns `{id, email, displayName, role}` read from the database.                                                                                                      |

Hardening:

- Access and refresh tokens carry a `kind` claim and cannot be swapped. The algorithm is pinned to HS256, with issuer and audience checks.
- Cookie-authenticated POSTs (`refresh`, `logout`) require `Origin` to equal `FRONTEND_ORIGIN`; a missing Origin is refused.
- Login is limited to 10 and refresh to 30 requests per minute per client IP.
- Passwords, cookies and access tokens are redacted from logs.
- Configuration is in `.env.example`. In production `JWT_SECRET` must be at least 32 random characters, or the server refuses to start.

## Accepted tradeoffs

- **Logout only clears the browser's cookie.** A copied refresh token stays valid until it expires or
  the user's `token_version` is bumped.
- **Revocation is per user, not per device or session.** Disabling an account or changing its role
  bumps `token_version`, which signs the user out everywhere.
- **No refresh rotation or reuse detection**, so concurrent refreshes are simply allowed.
- **No session table**, so there is no session cleanup or expiry job; token expiry lives in the JWT.

## Demo accounts

`npm run db:seed` creates an admin, employees and technicians (see `docs/database/fixtures.md`). All
share the synthetic demo password `SmartDesk-Demo-1!` (override with `SEED_DEMO_PASSWORD`). It is
public by design and must never be used outside a demo or test database.
