import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { ticketSearchResponseSchema } from '@smartdesk/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppOptions } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createSearchBulkClient } from '../../src/modules/search/bulk.js';
import { createSearchClient, type SearchClient } from '../../src/modules/search/client.js';
import { searchIndexes } from '../../src/modules/search/indexes.js';
import { initializeSearchIndexes } from '../../src/modules/search/initialize.js';
import { projectTicket, ticketSearchSelect } from '../../src/modules/search/projection.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({});
const tokens = new TokenService(env);
const testSearchUrl = process.env.TEST_OPENSEARCH_URL;
const path = '/api/tickets/search';
const newTicketId = '00000000-0000-4000-8000-0000000000ab';
const checkDb = async () => true;
const checkCache = async () => 'disabled' as const;

async function get(
  app: FastifyInstance,
  userId: string | null,
  query: Record<string, string> | string,
) {
  const encoded = typeof query === 'string' ? query : new URLSearchParams(query).toString();
  return app.inject({
    method: 'GET',
    url: `${path}?${encoded}`,
    headers: userId ? { authorization: `Bearer ${await tokens.sign('access', userId, 0)}` } : {},
  });
}

async function readPage(app: FastifyInstance, userId: string, query: Record<string, string>) {
  const response = await get(app, userId, query);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return ticketSearchResponseSchema.parse(response.json().data);
}

describe.skipIf(!testDatabaseUrl)('ticket search HTTP API', () => {
  const prisma = createTestPrisma();
  const apps: FastifyInstance[] = [];
  const engine = vi.fn<SearchClient['search']>();
  let disabled: FastifyInstance;
  let enabled: FastifyInstance;

  async function appWith(options: Partial<AppOptions> = {}) {
    const app = await buildApp({ env, prisma, checkDb, checkCache, logger: false, ...options });
    apps.push(app);
    return app;
  }

  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    disabled = await appWith();
    enabled = await appWith({ searchClient: { search: engine } });
  });
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('looks up an exact, newly created tracking ID in PostgreSQL with OpenSearch disabled', async () => {
    await prisma.ticket.create({
      data: {
        id: newTicketId,
        requesterId: USERS.erin,
        title: 'Just submitted',
        description: 'Private body',
      },
    });
    const page = await readPage(disabled, USERS.erin, {
      q: newTicketId.toUpperCase(),
      status: 'OPEN',
    });
    expect(page).toEqual({
      items: [
        expect.objectContaining({
          id: newTicketId,
          trackingId: newTicketId,
          title: 'Just submitted',
        }),
      ],
      mode: 'exact',
      consistency: 'current',
      nextCursor: null,
    });
    const missing = await readPage(disabled, USERS.erin, { q: newTicketId, status: 'CLOSED' });
    expect(missing.items).toEqual([]);
    expect(await readPage(disabled, USERS.omar, { q: newTicketId })).toEqual(missing);
    expect(
      await readPage(disabled, USERS.omar, { q: '00000000-0000-4000-8000-0000000000ff' }),
    ).toEqual(missing);
  });

  it('validates strict bounds and requires authentication before querying', async () => {
    engine.mockClear();
    expect((await get(enabled, null, { q: 'vpn' })).statusCode).toBe(401);
    for (const query of [
      '',
      'q=%20',
      'q=%2A',
      'q=vpn&q=printer',
      `q=${'x'.repeat(161)}`,
      'q=vpn&sort=priority',
      'q=vpn&offset=1',
      'q=vpn&limit=101',
      'q=vpn&limit=1e1',
      'q=vpn&status=some',
      'q=vpn&priority=INVALID',
      'q=vpn&categoryId=xyz',
      'q=vpn&teamId=abc',
      'q=vpn&assigneeId=abc',
      'q=vpn&createdFrom=2026-03-10',
      'q=vpn&createdFrom=2026-04-01T00:00:00Z&createdTo=2026-03-01T00:00:00Z',
      'q=vpn&query=%7B%7D',
      `q=${TICKETS.vpn}&cursor=fake`,
    ]) {
      expect((await get(enabled, USERS.erin, query)).statusCode, query).toBe(400);
    }
    expect(engine).not.toHaveBeenCalled();
  });

  it('limits team and assignee filters to the current role in both modes', async () => {
    engine.mockClear();
    for (const q of ['vpn', TICKETS.vpn]) {
      for (const [userId, filters] of [
        [USERS.erin, { teamId: TEAMS.network }],
        [USERS.erin, { assigneeId: USERS.tara }],
        [USERS.hana, { teamId: TEAMS.network }],
        [USERS.tara, { assigneeId: USERS.tom }],
      ] as const) {
        expect((await get(enabled, userId, { q, ...filters })).statusCode).toBe(403);
      }
    }
    expect(engine).not.toHaveBeenCalled();
    const filters = { q: TICKETS.password, teamId: TEAMS.network, assigneeId: USERS.tara };
    expect((await readPage(enabled, USERS.tara, filters)).items.map(({ id }) => id)).toEqual([
      TICKETS.password,
    ]);
    expect((await readPage(enabled, USERS.admin, filters)).items.map(({ id }) => id)).toEqual([
      TICKETS.password,
    ]);
  });

  it('rejects tampered, cross-user or changed-query continuations and hides index metadata', async () => {
    const seeded = await prisma.ticket.findMany({
      where: { id: { in: [TICKETS.printer, TICKETS.vpn, TICKETS.license] } },
      orderBy: { id: 'asc' },
    });
    engine.mockClear().mockImplementation(async (_collection, { searchAfter }) =>
      seeded
        .filter(({ id }) => !searchAfter || id > searchAfter[1]!)
        .map(({ id, version }) => ({
          id,
          sort: [1, id],
          revision: version,
          highlight: ['INDEX TEXT'],
          _source: { description: 'INDEX TEXT' },
        })),
    );
    const query = { q: 'test', limit: '1', sort: 'relevance' };
    const first = await readPage(enabled, USERS.erin, query);
    expect(first.mode).toBe('text');
    expect(first.consistency).toBe('eventual');
    expect(first.nextCursor).toBeTruthy();
    expect(first.items.map(({ id }) => id)).toEqual([TICKETS.printer]);
    expect(JSON.stringify(first)).not.toMatch(/INDEX TEXT|total|facets|description/);
    expect(first.nextCursor).not.toContain(TICKETS.printer);
    const cursor = first.nextCursor!;
    const second = await readPage(enabled, USERS.erin, { ...query, cursor });
    expect(second.items.map(({ id }) => id)).toEqual([TICKETS.vpn]);
    expect(second.nextCursor).toBeNull();
    for (const [user, attempt] of [
      [USERS.omar, { ...query, cursor }],
      [USERS.erin, { ...query, q: 'changed', cursor }],
      [USERS.erin, { ...query, status: 'OPEN', cursor }],
      [USERS.erin, { ...query, limit: '2', cursor }],
      [USERS.erin, { ...query, cursor: `A${cursor}` }],
    ] as const) {
      expect((await get(enabled, user, attempt)).statusCode).toBe(400);
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await get(enabled, USERS.erin, { ...query, cursor })).statusCode).toBe(400);
    } finally {
      vi.useRealTimers();
    }
    expect(engine).toHaveBeenCalledTimes(2);
  });

  it('returns scoped PostgreSQL matches when the index is disabled or fails, with the usual list available', async () => {
    const failing = await appWith({
      searchClient: createSearchClient(
        { enabled: true, url: 'http://search.invalid/' },
        {
          fetch: async () => new Response('upstream private data', { status: 404 }),
        },
      ),
    });
    const [latest, total] = await Promise.all([
      prisma.ticket.findFirstOrThrow({
        where: { requesterId: USERS.erin },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.ticket.count({ where: { requesterId: USERS.erin } }),
    ]);
    for (const [app, reason] of [
      [disabled, 'disabled'],
      [failing, 'unavailable'],
    ] as const) {
      const fallback = await readPage(app, USERS.erin, { q: 'vpn' });
      expect(fallback).toMatchObject({ mode: 'fallback', reason, consistency: 'current' });
      expect(fallback.items.map(({ id }) => id)).toContain(TICKETS.vpn);
      expect(JSON.stringify(fallback)).not.toMatch(/upstream|search\.invalid/);
      const normal = await app.inject({
        method: 'GET',
        url: '/api/tickets?limit=1',
        headers: { authorization: `Bearer ${await tokens.sign('access', USERS.erin, 0)}` },
      });
      expect(normal.statusCode).toBe(200);
      expect(normal.json().data).toEqual({
        items: [expect.objectContaining({ id: latest.id })],
        limit: 1,
        offset: 0,
        nextOffset: 1,
        total,
      });
    }
    expect((await readPage(failing, USERS.erin, { q: TICKETS.vpn })).items).toHaveLength(1);
    const detail = await failing.inject({
      method: 'GET',
      url: `/api/tickets/${TICKETS.vpn}`,
      headers: { authorization: `Bearer ${await tokens.sign('access', USERS.erin, 0)}` },
    });
    expect(detail.statusCode).toBe(200);
  });

  it('rate-limits search by account and omits search terms from application request logs', async () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    const search = vi.fn<SearchClient['search']>().mockResolvedValue([]);
    const limited = await appWith({
      searchClient: { search },
      ticketSearchRateLimit: { max: 1, windowMs: 60_000 },
      logger: { level: 'info', stream },
    });
    const query = { q: 'private-search-phrase' };
    expect((await get(limited, USERS.erin, query)).statusCode).toBe(200);
    expect((await get(limited, USERS.erin, query)).statusCode).toBe(429);
    expect((await get(limited, USERS.omar, query)).statusCode).toBe(200);
    expect(search).toHaveBeenCalledTimes(2);
    expect(logs.join('')).toContain(path);
    expect(logs.join('')).not.toContain(query.q);
  });
});

describe.skipIf(!testDatabaseUrl || !testSearchUrl)('ticket search API against OpenSearch', () => {
  const prisma = createTestPrisma();
  const realEnv = { ...env, openSearch: { enabled: true, url: testSearchUrl! } as const };
  const config = realEnv.openSearch;
  const indexes = Object.values(searchIndexes).map(({ name }) => name);
  let ownsIndexes = false;
  let app: FastifyInstance;
  const raw = (method: string, endpoint: string) =>
    fetch(new URL(endpoint, config.url), { method, signal: AbortSignal.timeout(5000) });

  beforeAll(async () => {
    for (const index of indexes) expect((await raw('HEAD', index)).status).toBe(404);
    ownsIndexes = true;
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    await initializeSearchIndexes(config);
    const rows = await prisma.ticket.findMany({ select: ticketSearchSelect });
    expect(await createSearchBulkClient(config)!.write(rows.map(projectTicket))).toEqual(
      rows.map(() => ({ ok: true })),
    );
    const refreshed = await raw('POST', `${searchIndexes.tickets.name}/_refresh`);
    await refreshed.body?.cancel();
    expect(refreshed.ok).toBe(true);
    app = await buildApp({ env: realEnv, prisma, checkDb, checkCache, logger: false });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    if (ownsIndexes) {
      for (const index of indexes) {
        const response = await raw('DELETE', index);
        await response.body?.cancel();
      }
    }
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it.each([
    ['vnp', TICKETS.vpn],
    ['pritner', TICKETS.printer],
  ])('ranks the ticket for misspelled %s', async (q, id) => {
    const employee = await readPage(app, USERS.erin, { q });
    expect(employee.items[0]?.id).toBe(id);
    const other = await readPage(app, USERS.omar, { q });
    expect(other.items.map((ticket) => ticket.id)).not.toContain(id);
  });

  it('combines text with filters and pages in the same order as the complete result', async () => {
    const filtered = await readPage(app, USERS.tara, {
      q: 'vnp',
      status: 'TRIAGED',
      priority: 'HIGH',
      categoryId: CATEGORIES.network,
      teamId: TEAMS.network,
      createdFrom: '2026-03-02T09:00:00-05:00',
      createdTo: '2026-03-03T00:00:00Z',
    });
    expect(filtered.items.map(({ id }) => id)).toEqual([TICKETS.vpn]);
    const all = await readPage(app, USERS.erin, { q: 'vpn' });
    expect(all.items.length).toBeGreaterThan(1);
    const first = await readPage(app, USERS.erin, { q: 'vpn', limit: '1' });
    const second = await readPage(app, USERS.erin, {
      q: 'vpn',
      limit: '1',
      cursor: first.nextCursor!,
    });
    expect([...first.items, ...second.items]).toEqual(all.items.slice(0, 2));
  });
});
