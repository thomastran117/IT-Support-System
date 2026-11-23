import type { SearchIndexEntityType } from '../../db/repositories/searchIndexJobs.js';
import type { Db } from '../../db/transaction.js';
import type { SearchIndexWrite } from './bulk.js';
import {
  knowledgeSearchSelect,
  projectKnowledge,
  projectRemoval,
  projectTicket,
  ticketSearchSelect,
} from './projection.js';

interface SearchSourceChange {
  entityType: SearchIndexEntityType;
  entityId: string;
  revision: number;
}

function entityIds(jobs: readonly SearchSourceChange[], type: SearchIndexEntityType): string[] {
  return [...new Set(jobs.filter((job) => job.entityType === type).map((job) => job.entityId))];
}

/** Keep removals at least as new as any durable revision, even if the source row is gone. */
async function missingRevisions(db: Db, entityType: SearchIndexEntityType, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const revisions = await db.searchIndexJob.groupBy({
    by: ['entityId'],
    where: { entityType, entityId: { in: ids } },
    _max: { revision: true },
  });
  return new Map(revisions.map((row) => [row.entityId, row._max.revision ?? 0]));
}

export async function loadSearchChanges<T extends SearchSourceChange>(db: Db, jobs: readonly T[]) {
  const ticketIds = entityIds(jobs, 'TICKET');
  const articleIds = entityIds(jobs, 'KNOWLEDGE_ARTICLE');
  const [ticketRows, articleRows] = await Promise.all([
    ticketIds.length
      ? db.ticket.findMany({ where: { id: { in: ticketIds } }, select: ticketSearchSelect })
      : [],
    articleIds.length
      ? db.knowledgeArticle.findMany({
          where: { id: { in: articleIds } },
          select: knowledgeSearchSelect,
        })
      : [],
  ]);
  const tickets = new Map(ticketRows.map((row) => [row.id, row]));
  const articles = new Map(articleRows.map((row) => [row.id, row]));
  const [removedTickets, removedArticles] = await Promise.all([
    missingRevisions(
      db,
      'TICKET',
      ticketIds.filter((id) => !tickets.has(id)),
    ),
    missingRevisions(
      db,
      'KNOWLEDGE_ARTICLE',
      articleIds.filter((id) => !articles.has(id)),
    ),
  ]);

  // A batch may contain several jobs for the same entity. Write its current projection once.
  const pending = new Map<string, { write: SearchIndexWrite; jobs: T[] }>();
  const mismatches: T[] = [];
  for (const job of jobs) {
    const ticket = job.entityType === 'TICKET' ? tickets.get(job.entityId) : undefined;
    const article = job.entityType === 'KNOWLEDGE_ARTICLE' ? articles.get(job.entityId) : undefined;
    const revision = ticket?.version ?? article?.searchRevision;
    if (revision !== undefined && revision < job.revision) {
      mismatches.push(job);
      continue;
    }

    const key = `${job.entityType}:${job.entityId}`;
    const existing = pending.get(key);
    if (existing) {
      existing.jobs.push(job);
      continue;
    }
    const removed = job.entityType === 'TICKET' ? removedTickets : removedArticles;
    const write = ticket
      ? projectTicket(ticket)
      : article
        ? projectKnowledge(article)
        : projectRemoval(
            job.entityType,
            job.entityId,
            Math.max(job.revision, removed.get(job.entityId) ?? 0),
          );
    pending.set(key, { write, jobs: [job] });
  }
  return { batch: [...pending.values()], mismatches };
}
