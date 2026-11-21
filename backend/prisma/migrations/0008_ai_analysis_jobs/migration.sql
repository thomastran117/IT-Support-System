-- SD-035: durable queue for AI ticket analysis (a PostgreSQL outbox).
--
-- A job row is inserted in the SAME transaction as the ticket it analyses, so dispatch can never be
-- lost between "ticket committed" and "work queued" and a rolled-back ticket leaves no job. Workers
-- claim rows with FOR UPDATE SKIP LOCKED and a time-limited lease; a worker that dies simply lets the
-- lease expire and the job is claimed again. `(ticket_id, request_id)` is the idempotency key: enqueuing
-- the same analysis request twice yields one job. `attempts` counts claims and is bounded by
-- `max_attempts`; `error_kind` is a short reason code, never message text, ticket text or secrets.
CREATE TABLE "ai_analysis_jobs" (
    "job_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "request_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state" VARCHAR(10) NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "locked_until" TIMESTAMPTZ(6),
    "error_kind" VARCHAR(24),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_analysis_jobs_pkey" PRIMARY KEY ("job_id")
);

ALTER TABLE "ai_analysis_jobs"
  ADD CONSTRAINT "ai_analysis_jobs_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "uq_ai_analysis_jobs_ticket_request" UNIQUE ("ticket_id", "request_id"),
  ADD CONSTRAINT "ck_ai_jobs_state" CHECK ("state" IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  ADD CONSTRAINT "ck_ai_jobs_attempts" CHECK ("attempts" >= 0 AND "max_attempts" > 0),
  -- A lease exists exactly while the job is RUNNING.
  ADD CONSTRAINT "ck_ai_jobs_lease" CHECK (
    ("state" = 'RUNNING') = ("lease_token" IS NOT NULL AND "locked_until" IS NOT NULL)
  ),
  -- A terminal state carries a completion time and nothing else does.
  ADD CONSTRAINT "ck_ai_jobs_terminal" CHECK (
    ("state" IN ('COMPLETED', 'FAILED')) = ("completed_at" IS NOT NULL)
  );

CREATE INDEX "idx_ai_jobs_claim" ON "ai_analysis_jobs"("state", "run_after");
CREATE INDEX "idx_ai_jobs_ticket" ON "ai_analysis_jobs"("ticket_id", "created_at" DESC);
