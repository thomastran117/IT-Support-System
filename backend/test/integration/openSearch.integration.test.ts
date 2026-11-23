import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSearchClient } from '../../src/modules/search/client.js';
import {
  searchIndexes,
  type KnowledgeSearchDocument,
  type TicketSearchDocument,
} from '../../src/modules/search/indexes.js';
import { initializeSearchIndexes } from '../../src/modules/search/initialize.js';

const testUrl = process.env.TEST_OPENSEARCH_URL;
const { tickets, knowledge } = searchIndexes;
const ticket: TicketSearchDocument = {
  id: '00000000-0000-4000-8000-000000000011',
  trackingId: '00000000-0000-4000-8000-000000000011',
  requesterId: '00000000-0000-4000-8000-000000000022',
  teamId: '00000000-0000-4000-8000-000000000033',
  assigneeId: null,
  categoryId: null,
  status: 'OPEN',
  priority: 'HIGH',
  title: 'Wireless VPN Access',
  description: 'The laptop loses its office connection.',
  createdAt: '2026-01-12T12:00:00.000Z',
  updatedAt: '2026-01-12T13:00:00.000Z',
  version: 1,
};
const article: KnowledgeSearchDocument = {
  articleId: '00000000-0000-4000-8000-000000000044',
  categoryId: '00000000-0000-4000-8000-000000000055',
  title: 'Printer setup',
  body: 'Clear the print spooler to restore printing.',
  isPublished: true,
  version: 2,
};
const draftId = '00000000-0000-4000-8000-000000000066';

describe.skipIf(!testUrl)('OpenSearch v1 mappings and aliases (integration)', () => {
  const config = { enabled: true, url: testUrl ?? 'http://search.invalid/' } as const;
  const client = createSearchClient(config, { timeoutMs: 3_000 })!;
  let ownsIndexes = false;
  const raw = async (method: string, path: string, body?: object) => {
    const response = await fetch(new URL(path, config.url), {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return { status: response.status, body: method === 'HEAD' ? undefined : await response.json() };
  };
  const write = (target: string, id: string, document: object) =>
    raw('PUT', `${target}/_doc/${id}?require_alias=true&refresh=wait_for`, document);

  beforeAll(async () => {
    // Fixed production alias names are safe here only on an unused test cluster.
    for (const index of Object.values(searchIndexes)) {
      expect(await raw('HEAD', index.name)).toMatchObject({ status: 404 });
      expect(await raw('GET', `_alias/${index.aliasPattern}?expand_wildcards=all`)).toEqual({
        status: 200,
        body: {},
      });
    }
    ownsIndexes = true;
    await Promise.all([initializeSearchIndexes(config), initializeSearchIndexes(config)]);
    expect(await write(tickets.writeAlias, ticket.id, ticket)).toMatchObject({ status: 201 });
    expect(await write(knowledge.writeAlias, article.articleId, article)).toMatchObject({
      status: 201,
    });
    expect(
      await write(knowledge.writeAlias, draftId, {
        ...article,
        articleId: draftId,
        isPublished: false,
      }),
    ).toMatchObject({ status: 201 });
  }, 30_000);

  afterAll(async () => {
    if (ownsIndexes) {
      for (const index of Object.values(searchIndexes)) await raw('DELETE', index.name);
    }
  });

  it('can reinitialize safely and uses distinct read and write aliases', async () => {
    await initializeSearchIndexes(config);
    for (const index of Object.values(searchIndexes)) {
      const aliases = await raw('GET', `_alias/${index.aliasPattern}`);
      expect(Object.keys(aliases.body)).toEqual([index.name]);
      expect(aliases.body[index.name].aliases).toMatchObject({
        [index.readAlias]: { is_write_index: false },
        [index.writeAlias]: { is_write_index: true },
      });
    }
    expect(await write(tickets.readAlias, ticket.id, ticket)).toMatchObject({ status: 400 });
    expect(await write(tickets.name, ticket.id, ticket)).toMatchObject({ status: 404 });
  });

  it('matches exact tracking IDs and keyword filters without tokenizing them', async () => {
    const search = (trackingId: string) =>
      client.search('tickets', {
        size: 10,
        query: {
          bool: {
            filter: [
              { term: { trackingId } },
              { term: { requesterId: ticket.requesterId } },
              { term: { teamId: ticket.teamId } },
              { term: { status: 'OPEN' } },
              { term: { priority: 'HIGH' } },
            ],
          },
        },
      });
    await expect(search(ticket.trackingId)).resolves.toEqual([{ id: ticket.id }]);
    await expect(search(ticket.trackingId.slice(0, 8))).resolves.toEqual([]);
  });

  it('analyzes ticket text and compares dates with a stable sort field', async () => {
    const search = (gte: string) =>
      client.search('tickets', {
        size: 10,
        query: {
          bool: {
            must: [{ match: { title: 'vpn' } }, { match: { description: 'LAPTOP' } }],
            filter: [{ range: { createdAt: { gte } } }],
          },
        },
        sort: [{ id: 'asc' }],
      });
    await expect(search('2026-01-01')).resolves.toEqual([{ id: ticket.id, sort: [ticket.id] }]);
    await expect(search('2026-02-01')).resolves.toEqual([]);
  });

  it('isolates published knowledge from tickets and filters unpublished documents', async () => {
    await expect(
      client.search('knowledge', {
        size: 10,
        query: {
          bool: {
            must: [{ match: { body: 'SPOOLER' } }],
            filter: [{ term: { categoryId: article.categoryId } }],
          },
        },
      }),
    ).resolves.toEqual([{ id: article.articleId }]);
    const all = { size: 10, query: { match_all: {} } };
    await expect(client.search('tickets', all)).resolves.toEqual([{ id: ticket.id }]);
    await expect(client.search('knowledge', all)).resolves.toEqual([{ id: article.articleId }]);
  });

  it('rejects private fields, fields from the other index, and invalid date or version values', async () => {
    for (const document of [
      { ...ticket, internalNotes: 'private only' },
      { ...ticket, articleId: article.articleId },
      { ...ticket, createdAt: 'not-a-date' },
      { ...ticket, version: '1' },
    ]) {
      expect(await write(tickets.writeAlias, ticket.id, document)).toMatchObject({ status: 400 });
    }
    expect(
      await write(knowledge.writeAlias, article.articleId, {
        ...article,
        requesterId: ticket.requesterId,
      }),
    ).toMatchObject({ status: 400 });
  });

  it('refuses to change an existing conflicting alias on a closed index', async () => {
    const scratch = 'smartdesk-tickets-mapping-test-conflict';
    const created = await raw('PUT', scratch, {
      aliases: { [tickets.readAlias]: { is_write_index: false } },
    });
    expect(created.status).toBe(200);
    try {
      expect(await raw('POST', `${scratch}/_close`)).toMatchObject({ status: 200 });
      await expect(initializeSearchIndexes(config)).rejects.toThrow(/require inspection/);
      const aliases = await raw('GET', `_alias/${tickets.readAlias}?expand_wildcards=all`);
      expect(Object.keys(aliases.body).sort()).toEqual([scratch, tickets.name].sort());
    } finally {
      await raw('DELETE', scratch);
    }
  });
});
