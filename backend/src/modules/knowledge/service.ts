import { createKnowledgeService as createService } from '@smartdesk/knowledge';
import type { PrismaClient } from '@smartdesk/db';
import type { SearchClient } from '../search/client.js';
import { createPublishedKnowledgeSearch } from './search.js';

export type { ListFilter } from '@smartdesk/knowledge';

export function createKnowledgeService(prisma: PrismaClient, searchClient?: SearchClient) {
  return createService(prisma, createPublishedKnowledgeSearch(prisma, searchClient));
}
