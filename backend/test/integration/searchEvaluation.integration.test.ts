import { ticketSearchResponseSchema } from '@smartdesk/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, TEAMS, TICKETS, USERS, uuid } from '../../src/db/seed/fixtures.js';
import { approveRouting } from '../../src/db/services/ticketService.js';
import { createKnowledgeService } from '../../src/modules/knowledge/service.js';
import { createSearchBulkClient } from '../../src/modules/search/bulk.js';
import { createSearchClient, type SearchClient } from '../../src/modules/search/client.js';
import { searchGeneration } from '../../src/modules/search/indexes.js';
import { createSearchRebuild } from '../../src/modules/search/rebuild.js';
import { createSearchRebuildAdmin } from '../../src/modules/search/rebuildAdmin.js';
import {
  evaluationArticles as articles,
  evaluationTickets as tickets,
  seedSearchEvaluationCorpus,
} from '../fixtures/searchEvaluation.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const searchUrl = process.env.TEST_OPENSEARCH_URL;
const env = loadEnv({});
const tokens = new TokenService(env);

describe.skipIf(!testDatabaseUrl).each(searchUrl ? ['PostgreSQL', 'OpenSearch'] : ['PostgreSQL'])(
  'labelled search corpus on %s',
  (engine) => {
    const prisma = createTestPrisma();
    const indexed = engine === 'OpenSearch';
    const config = { enabled: true, url: searchUrl ?? 'http://search.invalid/' } as const;
    const indexes = Object.values(searchGeneration(1));
    let app: FastifyInstance;
    let ownsIndexes = false;
    const apps: FastifyInstance[] = [];
    const client = indexed ? createSearchClient(config)! : undefined;

    async function build(searchClient = client) {
      const instance = await buildApp({
        env,
        prisma,
        checkDb: async () => true,
        checkCache: async () => 'disabled',
        logger: false,
        ...(searchClient && { searchClient }),
      });
      apps.push(instance);
      return instance;
    }

    async function get(
      path: 'tickets' | 'knowledge',
      user: keyof typeof USERS,
      q: string,
      filters: Record<string, string> = {},
      instance = app,
    ) {
      return instance.inject({
        url: `/api/${path}/search?${new URLSearchParams({ q, ...filters })}`,
        headers: { authorization: `Bearer ${await tokens.sign('access', USERS[user], 0)}` },
      });
    }

    async function ticketPage(
      user: keyof typeof USERS,
      q: string,
      filters: Record<string, string> = {},
      instance = app,
    ) {
      const response = await get('tickets', user, q, filters, instance);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toMatch(/"(?:total|count|highlight|description|facets)"\s*:/);
      return ticketSearchResponseSchema.parse(response.json().data);
    }

    beforeAll(async () => {
      if (indexed) {
        for (const name of indexes) {
          const response = await fetch(new URL(name, config.url), { method: 'HEAD' });
          expect(response.status).toBe(404);
        }
        ownsIndexes = true;
      }
      await resetDatabase(prisma);
      await seedSearchEvaluationCorpus(prisma, testDatabaseUrl!);
      if (indexed) {
        await createSearchRebuild({
          prisma,
          admin: createSearchRebuildAdmin(config),
          bulk: createSearchBulkClient(config, { targets: searchGeneration(1) })!,
          version: 1,
        }).run();
      }
      app = await build();
    }, 30_000);

    afterAll(async () => {
      try {
        await Promise.all(apps.map((instance) => instance.close()));
        if (ownsIndexes) {
          for (const name of indexes) {
            const response = await fetch(new URL(name, config.url), { method: 'DELETE' });
            await response.body?.cancel();
            expect(response.ok).toBe(true);
          }
        }
        await resetDatabase(prisma);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('applies the complete role matrix without counts, highlights or a cursor for denied rows', async () => {
      const matrix: [keyof typeof USERS, string[]][] = [
        ['erin', [tickets.network]],
        ['omar', [tickets.hardware, tickets.unassigned, tickets.legacy]],
        ['tara', [tickets.network, tickets.unassigned]],
        ['hana', [tickets.hardware, tickets.unassigned]],
        ['tom', [tickets.network, tickets.hardware, tickets.unassigned]],
        ['admin', [tickets.network, tickets.hardware, tickets.unassigned, tickets.legacy]],
      ];
      for (const [user, allowed] of matrix) {
        const received: string[] = [];
        let cursor: string | null = null;
        // Fix the page size to one so unauthorized matches cannot masquerade as continuations.
        for (let i = 0; i < allowed.length; i++) {
          const page = await ticketPage(user, 'relaycase', {
            limit: '1',
            ...(cursor && { cursor }),
          });
          expect(page.mode).toBe(indexed ? 'text' : 'fallback');
          expect(page.items).toHaveLength(1);
          received.push(page.items[0]!.id);
          cursor = page.nextCursor;
          expect(Boolean(cursor)).toBe(i + 1 < allowed.length);
        }
        expect(received.sort()).toEqual([...allowed].sort());
      }
      expect((await get('tickets', 'ivan', 'relaycase')).statusCode).toBe(401);
      expect((await get('tickets', 'ingrid', 'relaycase')).statusCode).toBe(401);
    });

    it('keeps exact lookup and ticket lifecycle filters authoritative', async () => {
      expect(await ticketPage('erin', tickets.legacy)).toEqual(
        await ticketPage('erin', uuid('ticket', 999)),
      );
      expect(await ticketPage('omar', tickets.legacy.toUpperCase())).toMatchObject({
        mode: 'exact',
        items: [{ id: tickets.legacy }],
        nextCursor: null,
      });
      expect(
        await ticketPage('tara', 'relaycase', {
          categoryId: CATEGORIES.network,
          teamId: TEAMS.network,
          assigneeId: USERS.tara,
          status: 'TRIAGED',
          priority: 'HIGH',
          createdFrom: '2026-03-15T12:00:00Z',
          createdTo: '2026-03-15T12:00:01Z',
        }),
      ).toMatchObject({ items: [{ id: tickets.network }], nextCursor: null });
      expect(
        (await get('tickets', 'tara', 'relaycase', { teamId: TEAMS.hardware })).statusCode,
      ).toBe(403);
      expect(await ticketPage('tara', 'spreadsheet', { status: 'OPEN' })).toMatchObject({
        items: [{ id: TICKETS.reopened, status: 'OPEN' }],
        nextCursor: null,
      });
      expect(await ticketPage('tara', 'licence', { teamId: TEAMS.network })).toMatchObject({
        items: [{ id: TICKETS.license }],
        nextCursor: null,
      });
    });

    it('counts only published articles and never displays drafts to the reader API', async () => {
      for (const user of ['erin', 'tara', 'admin'] as const) {
        const response = await get('knowledge', user, 'relaycase', {
          categoryId: CATEGORIES.network,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toMatchObject({
          items: [{ id: articles.network }],
          total: 1,
          nextOffset: null,
        });
        expect(response.body).not.toContain(articles.draft);
        expect(response.body).not.toMatch(/draft canary|"highlight"/i);
      }
    });

    it.skipIf(!indexed)(
      'rehydrates real stale candidates after membership, routing and publication change',
      async () => {
        const stale = async (change: () => Promise<unknown>, expectedId: string) =>
          build({
            async search(
              collection: Parameters<SearchClient['search']>[0],
              request: Parameters<SearchClient['search']>[1],
            ) {
              const candidates = await client!.search(collection, request);
              expect(candidates.map(({ id }) => id)).toContain(expectedId);
              await change();
              return candidates.map((candidate) => ({
                ...candidate,
                highlight: 'index-only canary',
              }));
            },
          });
        const revoked = await stale(
          () =>
            prisma.teamMember.delete({
              where: { teamId_userId: { teamId: TEAMS.hardware, userId: USERS.tom } },
            }),
          tickets.hardware,
        );
        const afterRevocation = await ticketPage('tom', 'relaycase', {}, revoked);
        expect(afterRevocation.mode).toBe('text');
        expect(afterRevocation.items.map(({ id }) => id).sort()).toEqual(
          [tickets.network, tickets.unassigned].sort(),
        );
        expect(afterRevocation.nextCursor).toBeNull();
        expect(JSON.stringify(afterRevocation)).not.toMatch(
          /docking station handshake|index-only canary/i,
        );

        const rerouted = await stale(
          () =>
            approveRouting(prisma, {
              ticketId: tickets.network,
              actorId: USERS.admin,
              priority: 'HIGH',
              teamId: TEAMS.hardware,
              categoryId: CATEGORIES.hardware,
            }),
          tickets.network,
        );
        const afterReroute = await ticketPage('tara', 'relaycase', {}, rerouted);
        expect(afterReroute).toMatchObject({
          mode: 'text',
          items: [{ id: tickets.unassigned }],
          nextCursor: null,
        });
        expect(afterReroute.items).toHaveLength(1);
        expect(JSON.stringify(afterReroute)).not.toContain('Relaycase VPN handshake fails');
        expect(await ticketPage('hana', 'relaycase', { teamId: TEAMS.hardware })).toMatchObject({
          mode: 'fallback',
          reason: 'index_lag',
          items: expect.arrayContaining([expect.objectContaining({ id: tickets.network })]),
        });

        const unpublished = await stale(
          () => createKnowledgeService(prisma).setPublished(articles.network, false),
          articles.network,
        );
        const afterUnpublish = await get('knowledge', 'admin', 'relaycase', {}, unpublished);
        expect(afterUnpublish.statusCode).toBe(200);
        expect(afterUnpublish.json().data).toMatchObject({
          items: [{ id: articles.hardware }],
          total: 1,
          nextOffset: null,
        });
        expect(afterUnpublish.body).not.toMatch(
          /index-only canary|"highlight"|VPN certificate handshake/i,
        );
        expect(afterUnpublish.body).not.toContain(articles.network);
      },
    );
  },
);
