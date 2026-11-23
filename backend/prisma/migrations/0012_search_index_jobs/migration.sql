-- SD-076: PostgreSQL search outbox. Source rows and their indexing intent commit together.
BEGIN;

ALTER TABLE "knowledge_articles"
  ADD COLUMN "search_revision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "ck_knowledge_articles_search_revision" CHECK ("search_revision" > 0);

-- The entity is polymorphic and remove jobs must survive source deletion, so it has no FK.
CREATE TABLE "search_index_jobs" (
  "job_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "entity_type" VARCHAR(20) NOT NULL,
  "entity_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "event_kind" VARCHAR(6) NOT NULL,
  "state" VARCHAR(10) NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" UUID,
  "locked_until" TIMESTAMPTZ(6),
  "error_kind" VARCHAR(24),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),

  CONSTRAINT "search_index_jobs_pkey" PRIMARY KEY ("job_id"),
  CONSTRAINT "uq_search_index_jobs_entity_revision" UNIQUE ("entity_type", "entity_id", "revision"),
  CONSTRAINT "ck_search_index_jobs_entity_type" CHECK ("entity_type" IN ('TICKET', 'KNOWLEDGE_ARTICLE')),
  CONSTRAINT "ck_search_index_jobs_revision" CHECK ("revision" > 0),
  CONSTRAINT "ck_search_index_jobs_event_kind" CHECK ("event_kind" IN ('UPSERT', 'DELETE')),
  CONSTRAINT "ck_search_index_jobs_state" CHECK ("state" IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT "ck_search_index_jobs_attempts" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts" AND "max_attempts" > 0),
  CONSTRAINT "ck_search_index_jobs_lease" CHECK (
    (("state" = 'RUNNING') = ("lease_token" IS NOT NULL)) AND
    (("state" = 'RUNNING') = ("locked_until" IS NOT NULL))
  ),
  CONSTRAINT "ck_search_index_jobs_terminal" CHECK (
    ("state" IN ('COMPLETED', 'FAILED')) = ("completed_at" IS NOT NULL)
  )
);

CREATE INDEX "idx_search_index_jobs_claim" ON "search_index_jobs"("state", "available_at", "job_id");
CREATE INDEX "idx_search_index_jobs_lease" ON "search_index_jobs"("state", "locked_until");

COMMIT;
