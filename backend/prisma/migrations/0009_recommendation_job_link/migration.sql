-- SD-036: tie each AI recommendation to the analysis job that produced it.
--
-- `job_id` is the idempotency marker for persistence: it is UNIQUE, so one analysis attempt (job)
-- can yield at most one recommendation however many times delivery is retried or duplicated. It is
-- NULL for recommendations that did not come from a job (fixtures, historical rows); several NULLs
-- are allowed. Re-analysis creates a new job and therefore a new, separate recommendation row.
ALTER TABLE "ai_recommendations"
  ADD COLUMN "job_id" UUID,
  ADD CONSTRAINT "ai_recommendations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ai_analysis_jobs"("job_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "uq_ai_recommendations_job" UNIQUE ("job_id");
