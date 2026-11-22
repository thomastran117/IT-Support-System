-- SD-043: delivery queue for the optional email channel.
--
-- One row per notification at most (`uq_notification_deliveries_notification`), so a notification
-- can never be queued for email twice however often the dispatcher sweeps or retries. The in-app
-- notification already exists and is complete before any delivery row does; a failed or disabled
-- email therefore never affects the ticket, the notification or the notification centre. Workers
-- claim rows with FOR UPDATE SKIP LOCKED and a time-limited lease, like ai_analysis_jobs.
-- `error_kind` is a short reason code, never an SMTP message, address, ticket text or credential.
CREATE TABLE "notification_deliveries" (
    "delivery_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "notification_id" UUID NOT NULL,
    "state" VARCHAR(10) NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "locked_until" TIMESTAMPTZ(6),
    "error_kind" VARCHAR(24),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("delivery_id")
);

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("notification_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "uq_notification_deliveries_notification" UNIQUE ("notification_id"),
  ADD CONSTRAINT "ck_notification_deliveries_state" CHECK ("state" IN ('QUEUED', 'RUNNING', 'SENT', 'FAILED', 'SKIPPED')),
  ADD CONSTRAINT "ck_notification_deliveries_attempts" CHECK ("attempts" >= 0 AND "max_attempts" > 0),
  -- A lease exists exactly while the delivery is RUNNING.
  ADD CONSTRAINT "ck_notification_deliveries_lease" CHECK (
    ("state" = 'RUNNING') = ("lease_token" IS NOT NULL AND "locked_until" IS NOT NULL)
  ),
  -- A terminal state carries a completion time and nothing else does.
  ADD CONSTRAINT "ck_notification_deliveries_terminal" CHECK (
    ("state" IN ('SENT', 'FAILED', 'SKIPPED')) = ("completed_at" IS NOT NULL)
  );

CREATE INDEX "idx_notification_deliveries_claim" ON "notification_deliveries"("state", "run_after");
