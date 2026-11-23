import type { TicketPriority, TicketStatus } from '@smartdesk/contracts';

export interface TicketSearchDocument {
  id: string;
  trackingId: string;
  requesterId: string;
  teamId: string | null;
  assigneeId: string | null;
  categoryId: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface KnowledgeSearchDocument {
  articleId: string;
  categoryId: string | null;
  title: string;
  body: string;
  isPublished: true;
  version: number;
}

type FieldMapping =
  | { type: 'keyword' | 'boolean' }
  | { type: 'text'; analyzer: 'standard' }
  | { type: 'date'; format: 'strict_date_optional_time' }
  | { type: 'long'; coerce: false };

const keyword = { type: 'keyword' } as const;
const text = { type: 'text', analyzer: 'standard' } as const;
const date = { type: 'date', format: 'strict_date_optional_time' } as const;
const version = { type: 'long', coerce: false } as const;

const ticketFields = {
  id: keyword,
  trackingId: keyword,
  requesterId: keyword,
  teamId: keyword,
  assigneeId: keyword,
  categoryId: keyword,
  status: keyword,
  priority: keyword,
  title: text,
  description: text,
  createdAt: date,
  updatedAt: date,
  version,
} satisfies Record<keyof TicketSearchDocument, FieldMapping>;

const knowledgeFields = {
  articleId: keyword,
  categoryId: keyword,
  title: text,
  body: text,
  isPublished: { type: 'boolean' },
  version,
} satisfies Record<keyof KnowledgeSearchDocument, FieldMapping>;

// An index's version changes with its mapping. Alias names stay stable across rebuilds.
export const searchIndexes = {
  tickets: {
    name: 'smartdesk-tickets-v1',
    aliasPattern: 'smartdesk-tickets-*',
    readAlias: 'smartdesk-tickets-read',
    writeAlias: 'smartdesk-tickets-write',
    mappings: { dynamic: 'strict', properties: ticketFields },
  },
  knowledge: {
    name: 'smartdesk-knowledge-v1',
    aliasPattern: 'smartdesk-knowledge-*',
    readAlias: 'smartdesk-knowledge-read',
    writeAlias: 'smartdesk-knowledge-write',
    mappings: { dynamic: 'strict', properties: knowledgeFields },
    readFilter: { term: { isPublished: true } },
  },
} as const;

export type SearchCollection = keyof typeof searchIndexes;
export type SearchIndex = (typeof searchIndexes)[SearchCollection];

export const searchCollections = [
  'tickets',
  'knowledge',
] as const satisfies readonly SearchCollection[];

export const searchGeneration = (version: number) => ({
  tickets: `smartdesk-tickets-v${version}`,
  knowledge: `smartdesk-knowledge-v${version}`,
});

export const liveSearchFilters = {
  tickets: { exists: { field: 'status' } },
  knowledge: searchIndexes.knowledge.readFilter,
} as const;
