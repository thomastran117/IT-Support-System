import {
  TICKET_PAGE_SIZE_MAX,
  type TicketPriority,
  type TicketStatus,
  type TicketSummaryDto,
} from '@smartdesk/contracts';
import type { Prisma, PrismaClient } from '@smartdesk/db';
import { loadActivePrincipal, type Principal } from '../../auth/guard.js';
import { isTicketId, ticketReadFilter, ticketReadScope } from '../../auth/ticketAccess.js';
import { HttpError } from '../../plugins/errors.js';
import { findTicketSummaries } from '../tickets/queries.js';
import type { SearchCandidate, SearchClient } from './client.js';

const MAX_CANDIDATE_PAGES = 3;
const MAX_CANDIDATE_PAGE_SIZE = 100;
const candidateOrder = [{ _score: 'desc' }, { id: 'asc' }] as const;

export interface TicketSearchFilters {
  status?: TicketStatus;
  priority?: TicketPriority;
  categoryId?: string;
  teamId?: string;
  assigneeId?: string;
  createdFrom?: Date;
  createdBefore?: Date;
}

/** Server-side continuation at the last authorized result. */
export type TicketSearchCursor = readonly [score: number, ticketId: string];

export interface TicketSearchInput {
  text?: string;
  filters?: TicketSearchFilters;
  limit: number;
  after?: TicketSearchCursor;
}

export interface TicketSearchPage {
  items: TicketSummaryDto[];
  nextCursor: TicketSearchCursor | null;
}

type RankedCandidate = { position: TicketSearchCursor; revision: number };

function indexScope(principal: Principal): Record<string, unknown>[] {
  const scope = ticketReadScope(principal);
  if (scope.kind === 'all') return [];
  const own = { term: { requesterId: scope.requesterId } };
  if (scope.teamIds.length === 0) return [own];
  return [
    {
      bool: {
        should: [
          own,
          { terms: { teamId: scope.teamIds } },
          { bool: { must_not: [{ exists: { field: 'teamId' } }] } },
        ],
        minimum_should_match: 1,
      },
    },
  ];
}

function ticketSearchFilters(filters: TicketSearchFilters) {
  const { status, priority, createdFrom, createdBefore } = filters;
  const terms = {
    status,
    priority,
    categoryId: filters.categoryId?.toLowerCase(),
    assigneeId: filters.assigneeId?.toLowerCase(),
  };
  const teamId = filters.teamId?.toLowerCase();
  const dates = { gte: createdFrom, lt: createdBefore };
  const hasDateRange = !!(createdFrom || createdBefore);
  const where: Prisma.TicketWhereInput = {
    ...terms,
    assignedTeamId: teamId,
    ...(hasDateRange && { createdAt: dates }),
  };
  const index: Record<string, unknown>[] = Object.entries({ ...terms, teamId })
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => ({ term: { [field]: value } }));
  if (hasDateRange) {
    index.push({
      range: { createdAt: { gte: createdFrom?.toISOString(), lt: createdBefore?.toISOString() } },
    });
  }
  return { where, index };
}

function readPosition(sort: readonly unknown[] | undefined): TicketSearchCursor | null {
  if (sort?.length !== 2) return null;
  const [score, id] = sort;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return null;
  return typeof id === 'string' && isTicketId(id) ? [score, id] : null;
}

function candidatePosition(hit: SearchCandidate, after: TicketSearchCursor | undefined) {
  const position = readPosition(hit.sort);
  if (!position || position[1] !== hit.id) return null;
  if (!after || position[0] < after[0] || (position[0] === after[0] && position[1] > after[1]))
    return position;
  return null;
}

async function collectCandidates(
  client: SearchClient,
  query: Record<string, unknown>,
  input: TicketSearchInput,
) {
  const size = Math.min(MAX_CANDIDATE_PAGE_SIZE, Math.max(25, 2 * (input.limit + 1)));
  const candidates: RankedCandidate[] = [];
  let after = input.after;
  for (let page = 0; page < MAX_CANDIDATE_PAGES; page += 1) {
    const start = after;
    const hits = await client.search('tickets', {
      query,
      size,
      sort: candidateOrder,
      searchAfter: after,
      includeRevision: true,
    });
    for (const hit of hits.slice(0, size)) {
      const position = candidatePosition(hit, after);
      if (!position) continue;
      after = position;
      if (hit.revision !== undefined && Number.isSafeInteger(hit.revision) && hit.revision > 0) {
        candidates.push({ position, revision: hit.revision });
      }
    }
    if (hits.length < size || after === start) break;
  }
  return candidates;
}

function rankSummaries(
  candidates: RankedCandidate[],
  summaries: TicketSummaryDto[],
  limit: number,
): TicketSearchPage {
  const remaining = new Map(summaries.map((ticket) => [ticket.id, ticket]));
  const items: TicketSummaryDto[] = [];
  let lastReturned: TicketSearchCursor | null = null;
  for (const { position, revision } of candidates) {
    const id = position[1].toLowerCase();
    const ticket = remaining.get(id);
    if (!ticket || ticket.version !== revision) continue;
    if (items.length === limit) return { items, nextCursor: lastReturned };
    items.push(ticket);
    remaining.delete(id);
    lastReturned = position;
  }
  return { items, nextCursor: null };
}

/** Read tickets for an authenticated principal. OpenSearch supplies a bounded window of candidates. */
export function createTicketSearchService(prisma: PrismaClient, client: SearchClient) {
  return {
    async search(principal: Principal, input: TicketSearchInput): Promise<TicketSearchPage> {
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > TICKET_PAGE_SIZE_MAX ||
        (input.after && !readPosition(input.after))
      ) {
        throw new HttpError(400, 'Invalid ticket search page');
      }
      const initial = await loadActivePrincipal(prisma, principal.id);
      if (!initial || initial.principal.role !== principal.role)
        throw new HttpError(401, 'Authentication required');

      const filters = ticketSearchFilters(input.filters ?? {});
      const text = input.text?.trim();
      const query = {
        bool: {
          must: [
            text
              ? { multi_match: { query: text, fields: ['title^2', 'description'] } }
              : { match_all: {} },
          ],
          filter: [...indexScope(initial.principal), ...filters.index],
        },
      };
      const candidates = await collectCandidates(client, query, input);
      const ids = [...new Set(candidates.map(({ position }) => position[1].toLowerCase()))];
      // After all search I/O, check account, membership, and tickets in one PostgreSQL snapshot.
      const summaries = await prisma.$transaction(
        async (tx) => {
          const current = await loadActivePrincipal(tx, principal.id);
          if (
            !current ||
            current.principal.role !== initial.principal.role ||
            current.tokenVersion !== initial.tokenVersion
          ) {
            throw new HttpError(401, 'Authentication required');
          }
          return ids.length === 0
            ? []
            : findTicketSummaries(tx, {
                AND: [ticketReadFilter(current.principal), { id: { in: ids } }, filters.where],
              });
        },
        { isolationLevel: 'RepeatableRead' },
      );
      return rankSummaries(candidates, summaries, input.limit);
    },
  };
}
