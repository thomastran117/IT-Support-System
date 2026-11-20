-- SD-013: account credentials for stateless JWT authentication.
--
-- * password_hash: Argon2id PHC string (salt and parameters are embedded in it). NULL means the
--   account has no credential yet and cannot log in. Plaintext is never stored.
-- * token_version: carried in every issued JWT. Bumping it (disable user, role change, forced
--   sign-out) invalidates all of that user's outstanding tokens without a session table.
ALTER TABLE "users"
  ADD COLUMN "password_hash" VARCHAR(255),
  ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_password_hash_argon2id"
    CHECK ("password_hash" IS NULL OR "password_hash" LIKE '$argon2id$%'),
  ADD CONSTRAINT "ck_users_token_version_nonnegative" CHECK ("token_version" >= 0);
