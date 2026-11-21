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
