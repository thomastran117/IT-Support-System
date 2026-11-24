import {
  analyseInputs,
  redactText,
  retrieveKnowledge,
  type KnowledgeReader,
  truncate,
  type AIProvider,
  type AnalysisInputs,
} from '@smartdesk/ai-analysis';
import type { PrismaClient } from '@smartdesk/db';
import { createPublishedRetrieval } from '@smartdesk/knowledge';
import { notFoundError } from '../../db/errors.js';
import { createPublishedKnowledgeSearch } from '../knowledge/search.js';
import type { SearchClient } from '../search/client.js';

export type { AnalysisDraft, AnalysisRetrieval } from '@smartdesk/ai-analysis';

export { buildRetrievalTerms, RETRIEVAL_LIMIT } from '@smartdesk/ai-analysis';

const MAX_TITLE_CHARS = 150;
const MAX_DESCRIPTION_CHARS = 4000;

/** Ticket supplies only the redacted ticket and currently allowed references. */
export function createAnalysisInputReader(
  prisma: PrismaClient,
  searchClient?: SearchClient,
  readKnowledge: KnowledgeReader = createPublishedRetrieval(
    prisma,
    createPublishedKnowledgeSearch(prisma, searchClient),
  ),
) {
  return async (ticketId: string, requestId?: string): Promise<AnalysisInputs> => {
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

    return {
      ticket: { title, description },
      allowedCategories: categories.map((ref) => ({
        ...ref,
        name: truncate(redactText(ref.name), 100),
      })),
      allowedTeams: teams.map((ref) => ({ ...ref, name: truncate(redactText(ref.name), 100) })),
      ...(await retrieveKnowledge(readKnowledge, { title, description }, requestId)),
    };
  };
}

export function createAnalysisService(deps: {
  prisma: PrismaClient;
  provider: AIProvider;
  searchClient?: SearchClient;
  readKnowledge?: KnowledgeReader;
}) {
  const readInputs = createAnalysisInputReader(deps.prisma, deps.searchClient, deps.readKnowledge);
  return {
    async analyse(ticketId: string, requestId?: string) {
      return analyseInputs(deps.provider, await readInputs(ticketId, requestId));
    },
  };
}

export type AnalysisService = ReturnType<typeof createAnalysisService>;
