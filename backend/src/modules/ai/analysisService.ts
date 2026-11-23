import type { PrismaClient } from '@smartdesk/db';
import { notFoundError } from '../../db/errors.js';
import { createPublishedKnowledgeSearch, type KnowledgeSearchEngine } from '../knowledge/search.js';
import type { SearchClient } from '../search/client.js';
import {
  ProviderError,
  type AIProvider,
  type AnalysisRequest,
  type ValidatedProposal,
} from './provider.js';
import { redactText, truncate } from './redact.js';

export const RETRIEVAL_LIMIT = 5;
const RETRIEVAL_VERSION = 1;
const OPENSEARCH_RETRIEVAL_MS = 1500;
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
 * Keep distinctive terms from the redacted ticket so an article can match only part of a long
 * description. The published search adapter expresses the same loose matching in both engines.
 */
export function buildRetrievalTerms(title: string, description: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  // Title words first: they are the strongest signal and must survive the term cap.
  for (const word of `${title} ${description}`.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (STOP_WORDS.has(word) || seen.has(word) || word.startsWith('redacted')) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

export interface AnalysisRetrieval {
  engine: KnowledgeSearchEngine;
  version: number;
}

/** A draft recommendation. It is advisory: nothing here has been written to the database. */
export interface AnalysisDraft extends ValidatedProposal {
  /** Published articles retrieved for the prompt, best match first. `citedArticleIds` is a subset. */
  retrievedArticleIds: string[];
  retrieval: AnalysisRetrieval;
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
export function createAnalysisService(deps: {
  prisma: PrismaClient;
  provider: AIProvider;
  searchClient?: SearchClient;
}) {
  const { prisma, provider, searchClient } = deps;
  const searchPublished = createPublishedKnowledgeSearch(prisma, searchClient);

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

      // Only terms from the redacted ticket reach the knowledge search adapter.
      const { hits, revisions, engine } = await searchPublished({
        query: buildRetrievalTerms(title, description),
        limit: RETRIEVAL_LIMIT,
        offset: 0,
        signal: AbortSignal.timeout(OPENSEARCH_RETRIEVAL_MS),
      });
      const rows = hits.length
        ? await prisma.knowledgeArticle.findMany({
            where: { id: { in: hits.map((h) => h.id) }, isPublished: true },
            select: { id: true, title: true, body: true, searchRevision: true },
          })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      // Keep rank order and drop articles unpublished or edited since the search snapshot.
      const articles = hits.flatMap((h) => {
        const r = byId.get(h.id);
        return r && r.searchRevision === revisions.get(h.id)
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
        retrieval: { engine, version: RETRIEVAL_VERSION },
      };
    },
  };
}

export type AnalysisService = ReturnType<typeof createAnalysisService>;
