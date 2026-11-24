import { Prisma, type TransactionClient } from '@smartdesk/db';
import type { Principal } from '../../auth/guard.js';
import { ticketReadScope } from '../../auth/ticketAccess.js';
import { findTicketSummaries } from '../tickets/queries.js';
import type { TicketSearchCursor, TicketSearchFilters, TicketSearchPage } from './ticketSearch.js';

// Match the expression in migration 0014 so the same GIN index serves search and lag detection.
const vector = Prisma.sql`(setweight(to_tsvector('english'::regconfig, t.title), 'A') ||
                           setweight(to_tsvector('english'::regconfig, t.description), 'B'))`;

function searchQuery(text: string) {
  return Prisma.sql`plainto_tsquery('english'::regconfig, ${text.replaceAll('\u0000', ' ')})`;
}

function ticketPredicates(principal: Principal, filters: TicketSearchFilters) {
  const predicates = [Prisma.sql`${vector} @@ q.terms`];
  const scope = ticketReadScope(principal);
  if (scope.kind === 'scoped') {
    const own = Prisma.sql`t.requester_id = ${scope.requesterId}::uuid`;
    predicates.push(
      scope.teamIds.length
        ? Prisma.sql`(${own} OR t.assigned_team_id IS NULL OR t.assigned_team_id = ANY(${[...scope.teamIds]}::uuid[]))`
        : own,
    );
  }
  if (filters.status) predicates.push(Prisma.sql`t.status = ${filters.status}`);
  if (filters.priority) predicates.push(Prisma.sql`t.priority = ${filters.priority}`);
  if (filters.categoryId) predicates.push(Prisma.sql`t.category_id = ${filters.categoryId}::uuid`);
  if (filters.teamId) predicates.push(Prisma.sql`t.assigned_team_id = ${filters.teamId}::uuid`);
  if (filters.assigneeId) predicates.push(Prisma.sql`t.assignee_id = ${filters.assigneeId}::uuid`);
  if (filters.createdFrom)
    predicates.push(Prisma.sql`t.created_at >= ${filters.createdFrom}::timestamptz`);
  if (filters.createdBefore)
    predicates.push(Prisma.sql`t.created_at < ${filters.createdBefore}::timestamptz`);
  return Prisma.join(predicates, ' AND ');
}

/** Scope the lag decision to current matches, including the refresh interval after a write. */
export async function hasPendingTicketMatches(
  tx: TransactionClient,
  principal: Principal,
  text: string,
  filters: TicketSearchFilters,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ pending: boolean }[]>`
    WITH q AS (SELECT ${searchQuery(text)} AS terms)
    SELECT EXISTS (
      SELECT 1
      FROM tickets t
      CROSS JOIN q
      JOIN search_index_jobs j ON j.entity_type = 'TICKET' AND j.entity_id = t.ticket_id AND j.revision = t.version
      WHERE ${ticketPredicates(principal, filters)}
        AND (j.state <> 'COMPLETED' OR j.completed_at > statement_timestamp() - interval '2 seconds')
    ) AS pending`;
  return row?.pending ?? false;
}

/** Both this ranked ID lookup and summary hydration use the caller's PostgreSQL snapshot. */
export async function searchTicketSummaries(
  tx: TransactionClient,
  principal: Principal,
  input: { text: string; filters: TicketSearchFilters; limit: number; after?: TicketSearchCursor },
): Promise<TicketSearchPage> {
  const { text, filters, limit, after } = input;
  const continuation = after
    ? Prisma.sql`WHERE score < ${after[0]}::float8 OR (score = ${after[0]}::float8 AND id > ${after[1]}::uuid)`
    : Prisma.empty;
  const rows = await tx.$queryRaw<{ id: string; score: number }[]>`
    WITH q AS (SELECT ${searchQuery(text)} AS terms),
    ranked AS (
      SELECT t.ticket_id AS id, ts_rank_cd(${vector}, q.terms)::float8 AS score
      FROM tickets t CROSS JOIN q
      WHERE ${ticketPredicates(principal, filters)}
    )
    SELECT id, score FROM ranked ${continuation}
    ORDER BY score DESC, id ASC
    LIMIT ${limit + 1}`;

  const page = rows.slice(0, limit);
  const summaries = await findTicketSummaries(tx, { id: { in: page.map(({ id }) => id) } });
  const byId = new Map(summaries.map((ticket) => [ticket.id, ticket]));
  const last = page.at(-1);
  return {
    items: page.map(({ id }) => byId.get(id)!),
    nextCursor: rows.length > limit && last ? [last.score, last.id] : null,
  };
}
