-- SD-078: sequence checkpoints for replay into replacement search indexes.
BEGIN;

ALTER TABLE "search_index_jobs" ADD COLUMN "sequence" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "uq_search_index_jobs_sequence" ON "search_index_jobs" ("sequence");

CREATE TABLE "search_rebuilds" (
  "version" INTEGER NOT NULL,
  "build_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source_version" INTEGER,
  "phase" VARCHAR(10) NOT NULL DEFAULT 'PREPARE',
  "scan_cursor" UUID,
  "replayed_through" BIGINT NOT NULL DEFAULT 0,
  "replay_until" BIGINT NOT NULL DEFAULT 0,
  "verified_tickets" INTEGER,
  "verified_articles" INTEGER,

  CONSTRAINT "search_rebuilds_pkey" PRIMARY KEY ("version"),
  CONSTRAINT "ck_search_rebuilds_version" CHECK ("version" > 0 AND ("source_version" IS NULL OR "source_version" > 0 AND "source_version" < "version")),
  CONSTRAINT "ck_search_rebuilds_phase" CHECK ("phase" IN ('PREPARE', 'TICKETS', 'KNOWLEDGE', 'REPLAY', 'CUTOVER', 'COMPLETED')),
  CONSTRAINT "ck_search_rebuilds_watermark" CHECK ("replayed_through" >= 0 AND "replay_until" >= "replayed_through")
);

COMMIT;
