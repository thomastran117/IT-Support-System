import { Prisma } from '@smartdesk/db';
import type { Db } from '../transaction.js';

export type ReviewDecision = 'ACCEPTED' | 'OVERRIDDEN' | 'REJECTED';

export const insertRecommendation = (
  db: Db,
  data: {
    ticketId: string;
    proposedCategoryId?: string | null;
    proposedTeamId?: string | null;
    proposedPriority?: string | null;
    suggestion?: string | null;
    confidence?: string | null;
    modelVersion: string;
  },
) => db.aiRecommendation.create({ data });

export const findRecommendation = (db: Db, id: string) =>
  db.aiRecommendation.findUnique({ where: { id } });

/**
 * Record the human review. Only review metadata changes: the original `proposed_*`, `suggestion`
 * and `confidence` columns are deliberately not part of this statement, so proposals stay immutable.
 * Only a PENDING recommendation can be reviewed; the return value is the rows changed (0 when
 * another reviewer already decided it). `reviewed_at` is never earlier than `created_at` (CHECK) even with clock skew.
 */
export async function markReviewed(
  db: Db,
  id: string,
  review: { decision: ReviewDecision; reviewerId: string; notes?: string | null },
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE ai_recommendations
    SET review_status = ${review.decision},
        reviewer_id = ${review.reviewerId}::uuid,
        reviewed_at = GREATEST(clock_timestamp(), created_at),
        review_notes = ${review.notes ?? null}
    WHERE recommendation_id = ${id}::uuid AND review_status = 'PENDING'`);
}

/**
 * Insert the recommendation for an analysis job, once. `job_id` is UNIQUE, so a repeat for the same
 * job inserts nothing and returns null (the caller then looks the existing row up and must not
 * link articles again). Using ON CONFLICT rather than catching the unique violation keeps an
 * enclosing transaction usable.
 */
export async function insertRecommendationForJob(
  db: Db,
  data: {
    jobId: string;
    ticketId: string;
    proposedCategoryId: string;
    proposedTeamId: string;
    proposedPriority: string;
    suggestion: string;
    confidence: number | null;
    modelVersion: string;
  },
): Promise<string | null> {
  const rows = await db.$queryRaw<{ recommendation_id: string }[]>`
    INSERT INTO ai_recommendations
      (job_id, ticket_id, proposed_category_id, proposed_team_id, proposed_priority,
       suggestion, confidence, model_version)
    VALUES
      (${data.jobId}::uuid, ${data.ticketId}::uuid, ${data.proposedCategoryId}::uuid,
       ${data.proposedTeamId}::uuid, ${data.proposedPriority}, ${data.suggestion},
       ${data.confidence}::numeric(4,3), ${data.modelVersion})
    ON CONFLICT (job_id) DO NOTHING
    RETURNING recommendation_id`;
  return rows[0]?.recommendation_id ?? null;
}

export const findRecommendationByJob = (db: Db, jobId: string) =>
  db.aiRecommendation.findUnique({ where: { jobId } });
