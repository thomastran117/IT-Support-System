import { AI_PRIORITIES, PROMPT_VERSION, type ValidatedProposal } from '@smartdesk/ai-analysis';
import type { TransactionClient } from '@smartdesk/db';
import { validationError } from '../../db/errors.js';
import {
  findRecommendationByJob,
  insertRecommendationForJob,
} from '../../db/repositories/aiRecommendations.js';
import { linkArticles } from '../../db/repositories/recommendationArticles.js';
import { insertServiceEvent } from '../../db/repositories/serviceEvents.js';
import type { PersistDraft } from './jobRunner.js';

const MODEL_VERSION_MAX = 100;

export interface PersistedRecommendation {
  recommendationId: string;
  /** False when this job had already produced its recommendation (a retry or duplicate delivery). */
  created: boolean;
}

/**
 * Store one analysis attempt as an immutable recommendation: proposed category/team/priority,
 * troubleshooting text, model and prompt version, optional confidence, and its ranked source
 * articles. Run it inside the transaction that completes the job (see `PersistDraft`).
 *
 * - **Idempotent per job:** `ai_recommendations.job_id` is unique, so retries and duplicate delivery
 *   yield exactly one row and never re-link articles. Re-analysis is a new job and a new row; earlier
 *   rows are kept.
 * - **Atomic:** the row and its article links are written together in the caller's transaction. Any
 *   validation or database failure throws, rolling the whole graph back, so no partial recommendation
 *   is ever visible.
 * - **Validated at write time**, against the database as it is now: active category and team, a
 *   known priority, 0..1 confidence, a bounded model version, and sources that exist, are published
 *   and are not repeated. Ranks are 1..n in the retrieval order given.
 * - **Pending and untouched:** the review state starts PENDING, the ticket is never changed, and
 *   the only later update path (`markReviewed`) does not write any proposed column.
 */
export async function persistRecommendation(
  tx: TransactionClient,
  ctx: { job: { id: string; ticketId: string }; draft: ValidatedProposal; promptVersion?: string },
): Promise<PersistedRecommendation> {
  const { job, draft } = ctx;

  const existing = await findRecommendationByJob(tx, job.id);
  if (existing) return { recommendationId: existing.id, created: false };

  const modelVersion = `${draft.modelVersion}@prompt-${ctx.promptVersion ?? PROMPT_VERSION}`;
  if (!draft.modelVersion.trim() || modelVersion.length > MODEL_VERSION_MAX) {
    throw validationError('Invalid model metadata');
  }
  if (!(AI_PRIORITIES as readonly string[]).includes(draft.priority)) {
    throw validationError('Invalid proposed priority');
  }
  if (!draft.troubleshooting.trim()) throw validationError('Troubleshooting text is empty');
  let confidence: number | null = null;
  if (draft.confidence !== null) {
    if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
      throw validationError('Confidence must be between 0 and 1');
    }
    confidence = Math.round(draft.confidence * 1000) / 1000;
  }

  const [category, team] = await Promise.all([
    tx.ticketCategory.findFirst({ where: { id: draft.categoryId, isActive: true } }),
    tx.supportTeam.findFirst({ where: { id: draft.teamId, isActive: true } }),
  ]);
  if (!category) throw validationError('Proposed category is unknown or inactive');
  if (!team) throw validationError('Proposed team is unknown or inactive');

  const articleIds = draft.citedArticleIds;
  if (new Set(articleIds).size !== articleIds.length) {
    throw validationError('Source articles must not repeat');
  }
  if (articleIds.length > 0) {
    const published = await tx.knowledgeArticle.count({
      where: { id: { in: articleIds }, isPublished: true },
    });
    if (published !== articleIds.length) {
      throw validationError('A source article does not exist or is not published');
    }
  }

  const id = await insertRecommendationForJob(tx, {
    jobId: job.id,
    ticketId: job.ticketId,
    proposedCategoryId: draft.categoryId,
    proposedTeamId: draft.teamId,
    proposedPriority: draft.priority,
    suggestion: draft.troubleshooting,
    confidence,
    modelVersion,
  });
  if (!id) {
    // Lost a race with another writer for the same job: theirs stands, link nothing again.
    const winner = await findRecommendationByJob(tx, job.id);
    return { recommendationId: winner!.id, created: false };
  }
  if (articleIds.length > 0) await linkArticles(tx, id, articleIds);
  const [event] = await tx.$queryRaw<
    { occurredAt: Date; aggregateVersion: number; requestId: string; correlationId: string }[]
  >`
    SELECT r.created_at AS "occurredAt", t.version AS "aggregateVersion",
           j.request_id AS "requestId", COALESCE(j.correlation_id, j.request_id::text) AS "correlationId"
    FROM ai_recommendations r
    JOIN ai_analysis_jobs j ON j.job_id = r.job_id
    JOIN tickets t ON t.ticket_id = r.ticket_id
    WHERE r.recommendation_id = ${id}::uuid`;
  await insertServiceEvent(tx, {
    schemaVersion: 1,
    eventId: id,
    type: 'recommendation.ready',
    occurredAt: event!.occurredAt.toISOString(),
    aggregateId: job.ticketId,
    aggregateVersion: event!.aggregateVersion,
    correlationId: event!.correlationId,
    payload: { recommendationId: id, jobId: job.id, requestId: event!.requestId },
  });
  return { recommendationId: id, created: true };
}

/** `persist` hook for the job runner. */
export const persistDraft: PersistDraft = async (tx, ctx) => {
  await persistRecommendation(tx, ctx);
};
