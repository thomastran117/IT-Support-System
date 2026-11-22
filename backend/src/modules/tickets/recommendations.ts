import type { PrismaClient } from '@smartdesk/db';
import type {
  RecommendationDto,
  RecommendationReviewStatus,
  TicketPriority,
} from '@smartdesk/contracts';

/** A ticket normally has a handful of analyses; the cap only bounds a pathological history. */
export const RECOMMENDATION_HISTORY_LIMIT = 50;

/**
 * Current and historical AI recommendations for one ticket, newest first, with the original
 * proposal, the review decision and the cited published articles. Read-only; the caller must
 * already have been authorized for staff access to the ticket.
 */
export async function listTicketRecommendations(
  prisma: PrismaClient,
  ticketId: string,
): Promise<RecommendationDto[]> {
  const rows = await prisma.aiRecommendation.findMany({
    where: { ticketId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: RECOMMENDATION_HISTORY_LIMIT,
    include: {
      proposedCategory: { select: { id: true, name: true, isActive: true } },
      proposedTeam: { select: { id: true, name: true, isActive: true } },
      reviewer: { select: { id: true, displayName: true } },
      articles: {
        where: { article: { isPublished: true } },
        orderBy: { relevanceRank: 'asc' },
        select: { article: { select: { id: true, title: true } } },
      },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    modelVersion: r.modelVersion,
    confidence: r.confidence === null ? null : Number(r.confidence.toString()),
    suggestion: r.suggestion,
    proposed: {
      category: r.proposedCategory,
      team: r.proposedTeam,
      priority: r.proposedPriority as TicketPriority | null,
    },
    review: {
      status: r.reviewStatus as RecommendationReviewStatus,
      reviewer: r.reviewer ? { id: r.reviewer.id, name: r.reviewer.displayName } : null,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      notes: r.reviewNotes,
    },
    articles: r.articles.map((a) => ({ id: a.article.id, title: a.article.title })),
  }));
}
