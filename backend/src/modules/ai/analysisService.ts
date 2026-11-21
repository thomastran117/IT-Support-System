import type { PrismaClient } from '@smartdesk/db';
import { notFoundError } from '../../db/errors.js';
import { searchPublished } from '../../db/repositories/knowledge.js';
import {
  ProviderError,
  type AIProvider,
  type AnalysisRequest,
  type ValidatedProposal,
} from './provider.js';
import { redactText, truncate } from './redact.js';

export const RETRIEVAL_LIMIT = 5;
const MAX_QUERY_TERMS = 12;
const MAX_TITLE_CHARS = 150;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_ARTICLE_TITLE_CHARS = 200;
const MAX_ARTICLE_BODY_CHARS = 1500;

const STOP_WORDS = new Set(
  (
    'about above after again also been before being cannot could does doing done from have here into just like ' +
    'more most much need only other over please same should since some still such than that their them then there ' +
    'these they this those through under until upon very want were what when where which while will with would your ' +
    'help issue problem ticket working works the and for are not but can has you any all its our get got'
  ).split(' '),
);

/**
 * Build a loose full-text query from redacted ticket text: distinctive words joined with `or`, so a
 * long description still matches articles that cover only part of it. `websearch_to_tsquery` treats
 * the whole string as data (see `searchPublished`), so no text here can alter the SQL.
 */
export function buildRetrievalQuery(title: string, description: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  // Title words first: they are the strongest signal and must survive the term cap.
  for (const word of `${title} ${description}`.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (STOP_WORDS.has(word) || seen.has(word) || word.startsWith('redacted')) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms.join(' or ');
}

/** A draft recommendation. It is advisory: nothing here has been written to the database. */
export interface AnalysisDraft extends ValidatedProposal {
  /** Published articles retrieved for the prompt, best match first. `citedArticleIds` is a subset. */
  retrievedArticleIds: string[];
}

/**
 * Ticket analysis orchestration: load ticket + active categories/teams, retrieve published articles,
 * minimise and redact what leaves the system, call the provider and return a validated draft.
 *
 * Read-only by construction: this service holds no write path to tickets or recommendations (that is
 * #48), and the provider only receives data and returns data, with no tools to call.
 *
 * Only title and description are sent: never requester identity, email, ids or ticket metadata.
 */
export function createAnalysisService(deps: { prisma: PrismaClient; provider: AIProvider }) {
  const { prisma, provider } = deps;

  return {
    async analyse(ticketId: string): Promise<AnalysisDraft> {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { title: true, description: true },
      });
      if (!ticket) throw notFoundError('Ticket');

      const title = truncate(redactText(ticket.title), MAX_TITLE_CHARS);
      const description = truncate(redactText(ticket.description), MAX_DESCRIPTION_CHARS);

      const [categories, teams] = await Promise.all([
        prisma.ticketCategory.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        prisma.supportTeam.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ]);

      // Search with the redacted text, so nothing sensitive reaches even the database query log.
      const { hits } = await searchPublished(prisma, {
        query: buildRetrievalQuery(title, description),
        limit: RETRIEVAL_LIMIT,
        offset: 0,
      });
      const rows = hits.length
        ? await prisma.knowledgeArticle.findMany({
            where: { id: { in: hits.map((h) => h.id) }, isPublished: true },
            select: { id: true, title: true, body: true },
          })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      // Keep search rank order; drop anything unpublished between the two queries.
      const articles = hits.flatMap((h) => {
        const r = byId.get(h.id);
        return r
          ? [
              {
                id: r.id,
                title: truncate(redactText(r.title), MAX_ARTICLE_TITLE_CHARS),
                body: truncate(redactText(r.body), MAX_ARTICLE_BODY_CHARS),
              },
            ]
          : [];
      });

      const request: AnalysisRequest = {
        ticket: { title, description },
        allowedCategories: categories,
        allowedTeams: teams,
        articles,
      };
      if (categories.length === 0 || teams.length === 0) {
        throw new ProviderError('invalid_reference', 'No active category or team to recommend');
      }

      const proposal = await provider.analyse(request);

      // Re-check against what was actually sent, independent of the provider implementation.
      const retrieved = articles.map((a) => a.id);
      const allowed = new Set(retrieved);
      if (
        !categories.some((c) => c.id === proposal.categoryId) ||
        !teams.some((t) => t.id === proposal.teamId) ||
        proposal.citedArticleIds.some((id) => !allowed.has(id))
      ) {
        throw new ProviderError('invalid_reference', 'AI output referenced an unknown record');
      }
      // Cited articles in retrieval order, so source ranking is stable and meaningful.
      const cited = new Set(proposal.citedArticleIds);
      return {
        ...proposal,
        citedArticleIds: retrieved.filter((id) => cited.has(id)),
        retrievedArticleIds: retrieved,
      };
    },
  };
}

export type AnalysisService = ReturnType<typeof createAnalysisService>;
