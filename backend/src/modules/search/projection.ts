import type { Prisma } from '@smartdesk/db';
import type { SearchIndexEntityType } from '../../db/repositories/searchIndexJobs.js';
import type { SearchIndexWrite } from './bulk.js';
import type { KnowledgeSearchDocument, TicketSearchDocument } from './indexes.js';

export const ticketSearchSelect = {
  id: true,
  requesterId: true,
  assignedTeamId: true,
  assigneeId: true,
  categoryId: true,
  status: true,
  priority: true,
  title: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  version: true,
} as const satisfies Prisma.TicketSelect;

export const knowledgeSearchSelect = {
  id: true,
  categoryId: true,
  title: true,
  body: true,
  isPublished: true,
  searchRevision: true,
} as const satisfies Prisma.KnowledgeArticleSelect;

/** Reserve the next version slot for removal at the same source revision. */
const externalVersion = (revision: number, removed = false) => revision * 2 + Number(removed);

export function projectTicket(
  row: Prisma.TicketGetPayload<{ select: typeof ticketSearchSelect }>,
): SearchIndexWrite {
  const document: TicketSearchDocument = {
    id: row.id,
    trackingId: row.id,
    requesterId: row.requesterId,
    teamId: row.assignedTeamId,
    assigneeId: row.assigneeId,
    categoryId: row.categoryId,
    status: row.status as TicketSearchDocument['status'],
    priority: row.priority as TicketSearchDocument['priority'],
    title: row.title,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
  return {
    collection: 'tickets',
    id: row.id,
    externalVersion: externalVersion(row.version),
    document,
  };
}

export type KnowledgeSource = Omit<
  Prisma.KnowledgeArticleGetPayload<{ select: typeof knowledgeSearchSelect }>,
  'title' | 'body'
> & { title: string | null; body: string | null };

export function projectKnowledge(row: KnowledgeSource): SearchIndexWrite {
  if (!row.isPublished || row.title === null || row.body === null) {
    return projectRemoval('KNOWLEDGE_ARTICLE', row.id, row.searchRevision);
  }
  const document: KnowledgeSearchDocument = {
    articleId: row.id,
    categoryId: row.categoryId,
    title: row.title,
    body: row.body,
    isPublished: true,
    version: row.searchRevision,
  };
  return {
    collection: 'knowledge',
    id: row.id,
    externalVersion: externalVersion(row.searchRevision),
    document,
  };
}

export function projectRemoval(
  entityType: SearchIndexEntityType,
  id: string,
  revision: number,
): SearchIndexWrite {
  const version = externalVersion(revision, true);
  // Replace the stored source entirely. The live-document filters also exclude this tombstone.
  return entityType === 'TICKET'
    ? { collection: 'tickets', id, externalVersion: version, document: { id, version: revision } }
    : {
        collection: 'knowledge',
        id,
        externalVersion: version,
        document: { articleId: id, isPublished: false, version: revision },
      };
}
