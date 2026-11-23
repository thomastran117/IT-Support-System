import type { TransactionClient } from '@smartdesk/db';

export type SearchIndexEventKind = 'UPSERT' | 'DELETE';

/** Write only indexing intent. The indexer will load the current source row from PostgreSQL. */
export function enqueueSearchIndexJob(
  tx: TransactionClient,
  job: {
    entityType: 'TICKET' | 'KNOWLEDGE_ARTICLE';
    entityId: string;
    revision: number;
    eventKind: SearchIndexEventKind;
  },
): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO search_index_jobs (entity_type, entity_id, revision, event_kind)
    VALUES (${job.entityType}, ${job.entityId}::uuid, ${job.revision}, ${job.eventKind})
    ON CONFLICT (entity_type, entity_id, revision) DO NOTHING`;
}
