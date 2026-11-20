-- SD-018: optimistic concurrency token and duplicate-submit protection for tickets.
--
-- `version` starts at 1 and is incremented by every ticket mutation. Writers send the version they
-- read and the UPDATE only matches that version, so a concurrent change is reported as a conflict
-- instead of being silently overwritten (see docs/database/concurrency.md).
--
-- `idempotency_key` is an optional client-chosen key (Idempotency-Key header). A retry of the same
-- submission by the same requester hits the unique index and resolves to the original ticket.
-- NULLs are distinct in a PostgreSQL unique index, so tickets without a key never collide.
ALTER TABLE "tickets"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "idempotency_key" VARCHAR(100),
  ADD CONSTRAINT "ck_tickets_version_positive" CHECK ("version" >= 1),
  ADD CONSTRAINT "ck_tickets_idempotency_key_nonblank"
    CHECK ("idempotency_key" IS NULL OR length(btrim("idempotency_key")) > 0);

CREATE UNIQUE INDEX "uq_tickets_requester_idempotency" ON "tickets"("requester_id", "idempotency_key");
