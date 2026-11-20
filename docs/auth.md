# Authentication design (epic E02)

Authentication is **stateless JWT**. The original E02 issues described server-side refresh sessions
(hashed refresh-token table, rotation, reuse detection); that was amended to stateless tokens, and
this page records what that means. Implementation lands issue by issue: SD-013 (this schema), then
SD-014 to SD-017.

## Model

| Piece                 | Design                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Password storage      | Argon2id, `m=19456 KiB, t=2, p=1`, random salt per hash, PHC string in `users.password_hash` (`backend/src/auth/password.ts`).                   |
| Access token          | Short-lived signed JWT (SD-014).                                                                                                                 |
| Refresh token         | Signed JWT in an HttpOnly cookie (SD-014). Not stored in PostgreSQL.                                                                             |
| Revocation            | `users.token_version`, copied into every token. Increment it and every outstanding token for that user stops working.                            |
| Per-request authority | The server re-reads role, `is_active`, `token_version` and team membership from the database (SD-015); claims are not trusted for authorization. |

Only salted password hashes exist in PostgreSQL. A user with `password_hash IS NULL` has no credential
and cannot sign in. There is no public signup; accounts are seeded or created by an administrator
(SD-017).

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
