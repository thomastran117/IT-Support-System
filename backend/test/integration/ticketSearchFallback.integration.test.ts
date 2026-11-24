import { ticketSearchResponseSchema } from '@smartdesk/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, TEAMS, TICKETS, USERS, uuid } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { approveRouting, submitTicket } from '../../src/db/services/ticketService.js';
import { createSearchClient, type SearchClient } from '../../src/modules/search/client.js';
import { SearchError } from '../../src/modules/search/transport.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({});
const tokens = new TokenService(env);
const ids = Array.from({ length: 5 }, (_, index) => uuid('ticket', 70 + index));

async function request(app: FastifyInstance, user: string, query: Record<string, string>) {
  return app.inject({
    method: 'GET',
    url: `/api/tickets/search?${new URLSearchParams(query)}`,
    headers: { authorization: `Bearer ${await tokens.sign('access', user, 0)}` },
  });
}

async function search(app: FastifyInstance, user: string, query: Record<string, string>) {
  const response = await request(app, user, query);
  expect(response.statusCode, response.body).toBe(200);
  return ticketSearchResponseSchema.parse(response.json().data);
}

describe.skipIf(!testDatabaseUrl)('PostgreSQL ticket text fallback', () => {
  const prisma = createTestPrisma();
  const apps: FastifyInstance[] = [];

  async function appWith(searchClient?: SearchClient) {
    const app = await buildApp({
      env,
      prisma,
      searchClient,
      logger: false,
      checkDb: async () => true,
      checkCache: async () => 'disabled',
    });
    apps.push(app);
    return app;
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    const scope = [
      {
        requesterId: USERS.erin,
        assignedTeamId: TEAMS.network,
        assigneeId: USERS.tara,
        categoryId: CATEGORIES.network,
        status: 'TRIAGED',
      },
      { requesterId: USERS.omar, assignedTeamId: TEAMS.hardware },
      { requesterId: USERS.omar },
      { requesterId: USERS.tara, assignedTeamId: TEAMS.hardware },
      { requesterId: USERS.erin, assignedTeamId: TEAMS.network },
    ];
    await prisma.ticket.createMany({
      data: scope.map((fields, index) => ({
        ...fields,
        id: ids[index]!,
        title: 'Scopeprobe fixture',
        description: 'Private fixture description',
        priority: 'HIGH',
        createdAt: new Date('2026-03-15T12:00:00Z'),
      })),
    });
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('applies requester, team, unassigned and admin scope before ranking and structured filtering', async () => {
    const app = await appWith();
    for (const [user, order] of [
      [USERS.erin, [0, 4]],
      [USERS.omar, [1, 2]],
      [USERS.tara, [0, 2, 3, 4]],
      [USERS.hana, [1, 2, 3]],
      [USERS.admin, [0, 1, 2, 3, 4]],
    ] as const) {
      const page = await search(app, user, { q: 'scopeprobe' });
      expect(page).toMatchObject({
        mode: 'fallback',
        consistency: 'current',
        reason: 'disabled',
        nextCursor: null,
      });
      expect(page.items.map(({ id }) => id)).toEqual(order.map((index) => ids[index]));
      expect(JSON.stringify(page)).not.toMatch(/description|total|facets|"score"/);
    }

    const filters = {
      q: 'scopeprobe',
      status: 'TRIAGED',
      priority: 'HIGH',
      categoryId: CATEGORIES.network,
      teamId: TEAMS.network,
      assigneeId: USERS.tara,
      createdFrom: '2026-03-15T12:00:00Z',
      createdTo: '2026-03-16T00:00:00Z',
    };
    expect((await search(app, USERS.tara, filters)).items.map(({ id }) => id)).toEqual([ids[0]]);
    expect(
      (
        await search(app, USERS.tara, {
          ...filters,
          createdFrom: '2026-03-15T00:00:00Z',
          createdTo: filters.createdFrom,
        })
      ).items,
    ).toEqual([]);
    for (const user of [USERS.erin, USERS.hana])
      expect((await request(app, user, filters)).statusCode).toBe(403);

    await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: false } });
    expect((await search(app, USERS.tara, { q: 'scopeprobe' })).items.map(({ id }) => id)).toEqual([
      ids[3],
    ]);
    expect((await request(app, USERS.tara, filters)).statusCode).toBe(403);
  });

  it('uses title and description stemming, excludes internal notes, and uses the GIN expression', async () => {
    const app = await appWith();
    expect(
      (await search(app, USERS.erin, { q: 'printers jammed' })).items.map(({ id }) => id),
    ).toContain(TICKETS.printer);
    await prisma.ticketComment.create({
      data: { ticketId: ids[0]!, authorId: USERS.tara, body: 'uniqueburiednote', isInternal: true },
    });
    expect((await search(app, USERS.admin, { q: 'uniqueburiednote' })).items).toEqual([]);
    expect((await search(app, USERS.admin, { q: "'); -- clause only" })).items).toEqual([]);
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT ticket_id FROM tickets
        WHERE (setweight(to_tsvector('english'::regconfig, title), 'A') ||
               setweight(to_tsvector('english'::regconfig, description), 'B')) @@ plainto_tsquery('english', 'scopeprobe')`;
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('idx_tickets_fts');
  });

  it('finds new and reassigned matches before indexing without announcing someone else’s lag', async () => {
    const engine = vi.fn<SearchClient['search']>().mockResolvedValue([]);
    const app = await appWith({ search: engine });
    const q = { q: 'transitprobe' };
    const { ticket } = await submitTicket(prisma, {
      requesterId: USERS.erin,
      title: 'Transitprobe issue',
      description: 'Help with transitprobe',
    });

    const owner = await search(app, USERS.erin, q);
    expect(owner).toMatchObject({
      mode: 'fallback',
      reason: 'index_lag',
      items: [{ id: ticket.id }],
    });
    expect(engine).not.toHaveBeenCalled();
    expect(await search(app, USERS.omar, q)).toMatchObject({ mode: 'text', items: [] });

    const route = (teamId: string) =>
      approveRouting(prisma, {
        ticketId: ticket.id,
        actorId: USERS.admin,
        priority: 'HIGH',
        categoryId: CATEGORIES.hardware,
        teamId,
      });
    await route(TEAMS.network);
    expect(await search(app, USERS.tara, q)).toMatchObject({
      mode: 'fallback',
      reason: 'index_lag',
      items: [{ id: ticket.id }],
    });
    await route(TEAMS.hardware);
    expect(await search(app, USERS.tara, q)).toMatchObject({ mode: 'text', items: [] });
    expect(await search(app, USERS.hana, q)).toMatchObject({
      mode: 'fallback',
      reason: 'index_lag',
      items: [{ id: ticket.id }],
    });

    await prisma.$executeRaw`UPDATE search_index_jobs SET state = 'COMPLETED', completed_at = statement_timestamp() WHERE entity_id = ${ticket.id}::uuid AND revision = (SELECT version FROM tickets WHERE ticket_id = ${ticket.id}::uuid)`;
    expect(await search(app, USERS.hana, q)).toMatchObject({
      mode: 'fallback',
      reason: 'index_lag',
      items: [{ id: ticket.id }],
    });
    await prisma.$executeRaw`UPDATE search_index_jobs SET completed_at = statement_timestamp() - interval '10 seconds' WHERE entity_id = ${ticket.id}::uuid AND state = 'COMPLETED'`;
    expect(await search(app, USERS.hana, q)).toMatchObject({ mode: 'text', items: [] });
    // Older queued revisions cannot affect the current search engine once the latest write is visible.
    expect(
      await prisma.searchIndexJob.count({ where: { entityId: ticket.id, state: 'QUEUED' } }),
    ).toBeGreaterThan(0);
  });

  it('falls back on transport timeouts and an open circuit', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('test timeout')));
        }),
    );
    const client = createSearchClient(
      { enabled: true, url: 'http://search.invalid/' },
      { fetch, timeoutMs: 10 },
    );
    const app = await appWith(client);
    const query = { q: 'scopeprobe' };
    const first = await search(app, USERS.erin, query);
    expect(first).toMatchObject({
      mode: 'fallback',
      reason: 'unavailable',
      items: [{ id: ids[0] }, { id: ids[4] }],
    });
    expect(await search(app, USERS.erin, query)).toEqual(first);
    expect(await search(app, USERS.erin, query)).toEqual(first);
    expect(await search(app, USERS.erin, query)).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('requires a restart when OpenSearch fails mid-page and pins PostgreSQL cursors after recovery', async () => {
    const engine = vi
      .fn<SearchClient['search']>()
      .mockResolvedValue(ids.map((id) => ({ id, sort: [1, id!], revision: 1 })));
    const app = await appWith({ search: engine });
    const query = { q: 'scopeprobe', limit: '1' };
    const first = await search(app, USERS.erin, query);
    expect(first).toMatchObject({
      mode: 'text',
      items: [{ id: ids[0] }],
      nextCursor: expect.any(String),
    });
    engine.mockRejectedValue(new SearchError('timeout'));
    const conflict = await request(app, USERS.erin, { ...query, cursor: first.nextCursor! });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().details).toEqual({ code: 'TICKET_SEARCH_RESTART' });

    const fallback = await search(app, USERS.erin, query);
    expect(fallback).toMatchObject({
      mode: 'fallback',
      reason: 'unavailable',
      items: [{ id: ids[0] }],
      nextCursor: expect.any(String),
    });
    engine.mockClear().mockResolvedValue([]);
    const cursor = fallback.nextCursor!;
    const second = await search(app, USERS.erin, { ...query, cursor });
    expect(second).toMatchObject({
      mode: 'fallback',
      reason: 'unavailable',
      items: [{ id: ids[4] }],
      nextCursor: null,
    });
    expect((await request(app, USERS.omar, { ...query, cursor })).statusCode).toBe(400);
    expect((await request(app, USERS.erin, { ...query, cursor, priority: 'LOW' })).statusCode).toBe(
      400,
    );
    expect(engine).not.toHaveBeenCalled();
  });
});
