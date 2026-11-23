import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadActivePrincipal } from '../../src/auth/guard.js';
import { CATEGORIES, TEAMS, TICKETS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import type { SearchClient } from '../../src/modules/search/client.js';
import {
  createTicketSearchService,
  type TicketSearchFilters,
} from '../../src/modules/search/ticketSearch.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const hit = (id: string, score: number, revision = 1) => ({ id, sort: [score, id], revision });
const syntheticId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ownFilter = (id: string) => ({ term: { requesterId: id } });
const teamFilter = (id: string, teamId: string) => ({
  bool: {
    should: [
      ownFilter(id),
      { terms: { teamId: [teamId] } },
      { bool: { must_not: [{ exists: { field: 'teamId' } }] } },
    ],
    minimum_should_match: 1,
  },
});

describe.skipIf(!testDatabaseUrl)('authorization of ticket search candidates', () => {
  const prisma = createTestPrisma();
  const engine = vi.fn<SearchClient['search']>();
  const service = createTicketSearchService(prisma, { search: engine });
  const principal = async (id: string) => (await loadActivePrincipal(prisma, id))!.principal;

  beforeEach(async () => {
    engine.mockReset();
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  async function createTaraTicket() {
    return prisma.ticket.create({
      data: {
        requesterId: USERS.tara,
        assignedTeamId: TEAMS.hardware,
        title: 'Tara’s own ticket',
        description: 'Fixture',
      },
    });
  }

  it('enforces the employee, active technician, inactive-team technician, and admin scopes in both stores', async () => {
    const own = await createTaraTicket();
    const rows = await prisma.ticket.findMany({
      select: { id: true, version: true },
      orderBy: { id: 'asc' },
    });
    engine.mockResolvedValue(
      rows.map(({ id, version }, index) => hit(id, rows.length - index, version)),
    );
    const {
      printer,
      vpn,
      license,
      password,
      monitor,
      reopened,
      aiDown,
      token,
      boundary,
      afterWindow,
    } = TICKETS;
    const matrix = [
      {
        id: USERS.erin,
        filters: [ownFilter(USERS.erin)],
        expected: [printer, vpn, password, reopened, token, afterWindow],
      },
      {
        id: USERS.omar,
        filters: [ownFilter(USERS.omar)],
        expected: [license, monitor, aiDown, boundary],
      },
      {
        id: USERS.tara,
        filters: [teamFilter(USERS.tara, TEAMS.network)],
        expected: [printer, vpn, license, password, reopened, aiDown, token, afterWindow, own.id],
      },
      {
        id: USERS.hana,
        filters: [teamFilter(USERS.hana, TEAMS.hardware)],
        expected: [printer, monitor, aiDown, token, boundary, afterWindow, own.id],
      },
      { id: USERS.admin, filters: [], expected: rows.map(({ id }) => id) },
    ];
    for (const { id, filters, expected } of matrix) {
      const result = await service.search(await principal(id), { limit: 20 });
      expect(new Set(result.items.map((ticket) => ticket.id))).toEqual(new Set(expected));
      expect(result.items).toHaveLength(expected.length);
      expect(result.nextCursor).toBeNull();
      expect(engine).toHaveBeenLastCalledWith(
        'tickets',
        expect.objectContaining({
          query: { bool: { must: [{ match_all: {} }], filter: filters } },
        }),
      );
    }

    const stalePrincipal = await principal(USERS.tara);
    await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: false } });
    const result = await service.search(stalePrincipal, { limit: 20 });
    expect(result.items.map(({ id }) => id)).toEqual([own.id]);
    expect(engine).toHaveBeenLastCalledWith(
      'tickets',
      expect.objectContaining({
        query: { bool: { must: [{ match_all: {} }], filter: [ownFilter(USERS.tara)] } },
      }),
    );
  });

  it('rechecks newly routed tickets after OpenSearch returns', async () => {
    engine.mockImplementationOnce(async () => {
      const moved = await prisma.ticket.update({
        where: { id: TICKETS.vpn },
        data: {
          assignedTeamId: TEAMS.hardware,
          version: { increment: 1 },
        },
      });
      const backlog = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } });
      return [hit(moved.id, 2, moved.version), hit(backlog.id, 1, backlog.version)];
    });
    const result = await service.search(await principal(USERS.tara), { limit: 10 });
    expect(result.items.map(({ id }) => id)).toEqual([TICKETS.printer]);
  });

  it('rejects a team filter when that team becomes inactive during the search', async () => {
    const user = await principal(USERS.tara);
    engine.mockImplementationOnce(async () => {
      await prisma.supportTeam.update({ where: { id: TEAMS.network }, data: { isActive: false } });
      return [];
    });
    await expect(
      service.search(user, { filters: { teamId: TEAMS.network }, limit: 10 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it.each(['membership removed', 'team inactive'])(
    'rehydrates ownership and backlog access when %s during the search',
    async (change) => {
      const own = await createTaraTicket();
      const rows = await prisma.ticket.findMany({
        where: { id: { in: [TICKETS.vpn, TICKETS.printer] } },
      });
      engine.mockImplementationOnce(async () => {
        if (change === 'membership removed') {
          await prisma.ticket.updateMany({
            where: { assigneeId: USERS.tara },
            data: { assigneeId: null },
          });
          await prisma.teamMember.delete({
            where: { teamId_userId: { teamId: TEAMS.network, userId: USERS.tara } },
          });
        } else {
          await prisma.supportTeam.update({
            where: { id: TEAMS.network },
            data: { isActive: false },
          });
        }
        return [
          ...rows.map(({ id, version }, index) => hit(id, 3 - index, version)),
          hit(own.id, 1, own.version),
        ];
      });
      const result = await service.search(await principal(USERS.tara), { limit: 10 });
      expect(result.items.map(({ id }) => id)).toEqual([own.id]);
    },
  );

  it.each([{ isActive: false }, { tokenVersion: { increment: 1 } }, { role: 'EMPLOYEE' }])(
    'rejects an account change during search (%j)',
    async (data) => {
      engine.mockImplementationOnce(async () => {
        await prisma.user.update({ where: { id: USERS.tara }, data });
        return [];
      });
      await expect(
        service.search(await principal(USERS.tara), { limit: 10 }),
      ).rejects.toMatchObject({ statusCode: 401 });
    },
  );

  it('rejects an already inactive account before querying the index', async () => {
    const stalePrincipal = await principal(USERS.erin);
    await prisma.user.update({ where: { id: USERS.erin }, data: { isActive: false } });
    await expect(service.search(stalePrincipal, { limit: 10 })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(engine).not.toHaveBeenCalled();
  });

  it('rechecks each filter and the indexed revision before constructing a PostgreSQL summary', async () => {
    const filters = {
      status: 'IN_PROGRESS',
      priority: 'MEDIUM',
      categoryId: CATEGORIES.software,
      teamId: TEAMS.network,
      assigneeId: USERS.tom,
      createdFrom: new Date('2026-03-03T10:00:00Z'),
      createdBefore: new Date('2026-03-04T10:00:00Z'),
    } satisfies TicketSearchFilters;
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.license } });
    const matching = {
      requesterId: USERS.omar,
      status: filters.status,
      priority: filters.priority,
      categoryId: filters.categoryId,
      assignedTeamId: filters.teamId,
      assigneeId: filters.assigneeId,
      title: 'Indexed match',
      description: 'Fixture',
      createdAt: filters.createdFrom,
    };
    const variations = [
      { status: 'TRIAGED' },
      { priority: 'HIGH' },
      { categoryId: CATEGORIES.network },
      { assignedTeamId: TEAMS.hardware },
      { assigneeId: USERS.tara },
      { createdAt: filters.createdBefore },
      { createdAt: new Date('2026-03-03T09:59:59Z') },
      { version: 2 },
    ];
    await prisma.ticket.createMany({
      data: variations.map((change, index) => ({ ...matching, ...change, id: syntheticId(index) })),
    });
    const forgedHit = {
      ...hit(ticket.id, 1, ticket.version),
      _source: { title: 'UNSAFE', description: 'UNSAFE' },
      highlight: { title: ['UNSAFE'] },
    };
    engine.mockResolvedValue([
      ...variations.map((_, index) => hit(syntheticId(index), 20 - index)),
      forgedHit,
    ]);

    const result = await service.search(await principal(USERS.admin), {
      text: '  licence  ',
      filters,
      limit: 10,
    });
    expect(result).toEqual({
      items: [
        expect.objectContaining({ id: ticket.id, title: ticket.title, version: ticket.version }),
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toContain('UNSAFE');
    expect(engine).toHaveBeenCalledWith(
      'tickets',
      expect.objectContaining({
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: 'licence',
                  fields: ['title^3', 'description'],
                  fuzziness: 'AUTO',
                  max_expansions: 10,
                },
              },
            ],
            filter: [
              { term: { status: 'IN_PROGRESS' } },
              { term: { priority: 'MEDIUM' } },
              { term: { categoryId: CATEGORIES.software } },
              { term: { assigneeId: USERS.tom } },
              { term: { teamId: TEAMS.network } },
              {
                range: {
                  createdAt: {
                    gte: filters.createdFrom.toISOString(),
                    lt: filters.createdBefore.toISOString(),
                  },
                },
              },
            ],
          },
        },
      }),
    );
  });

  it('overfetches past denied hits with a stable cursor that only contains an authorized result', async () => {
    const user = await principal(USERS.erin);
    const first = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.printer } });
    const second = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.vpn } });
    const denied = Array.from({ length: 24 }, (_, index) => hit(syntheticId(index), 5));
    // The denied results and the second authorized result tie. The ID order breaks that tie.
    const candidates = [
      hit(first.id, 6, first.version),
      ...denied,
      hit(second.id, 5, second.version),
    ];
    engine.mockImplementation(async (_collection, { searchAfter, size }) =>
      candidates
        .slice(searchAfter ? candidates.findIndex(({ id }) => id === searchAfter[1]) + 1 : 0)
        .slice(0, size),
    );

    const page = await service.search(user, { limit: 1 });
    expect(page.items.map(({ id }) => id)).toEqual([first.id]);
    expect(page.nextCursor).toEqual([6, first.id]);
    expect(engine).toHaveBeenCalledTimes(2);
    expect(engine).toHaveBeenNthCalledWith(
      1,
      'tickets',
      expect.objectContaining({
        sort: [{ _score: 'desc' }, { id: 'asc' }],
        includeRevision: true,
      }),
    );
    expect(JSON.stringify(page)).not.toContain(denied[0]!.id);
    const next = await service.search(user, { limit: 1, after: page.nextCursor! });
    expect(next.items.map(({ id }) => id)).toEqual([second.id]);
    expect(next.nextCursor).toBeNull();
  });

  it('omits continuation when remaining candidates are denied or malformed', async () => {
    const first = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKETS.vpn } });
    const user = await principal(USERS.erin);
    engine.mockResolvedValue([
      hit(first.id, 6, first.version),
      hit(TICKETS.license, 5),
      hit('invalid-uuid', 4),
      { ...hit(TICKETS.printer, 3), sort: [3, TICKETS.token] },
      { id: TICKETS.printer, sort: [2, TICKETS.printer] },
      hit(first.id, 1, first.version),
    ]);
    expect(await service.search(user, { limit: 1 })).toEqual({
      items: [expect.objectContaining({ id: first.id })],
      nextCursor: null,
    });
  });

  it('bounds the number of pages and stops a repeated cursor without exposing rejected hits', async () => {
    const user = await principal(USERS.erin);
    const empty = { items: [], nextCursor: null };
    engine.mockImplementation(async (_collection, { size }) => {
      const start = (engine.mock.calls.length - 1) * size;
      return Array.from({ length: size }, (_, index) => hit(syntheticId(start + index), 1));
    });
    expect(await service.search(user, { limit: 1 })).toEqual(empty);
    expect(engine).toHaveBeenCalledTimes(3);

    engine.mockClear().mockResolvedValue(Array.from({ length: 25 }, () => hit(TICKETS.license, 1)));
    expect(await service.search(user, { limit: 1 })).toEqual(empty);
    expect(engine).toHaveBeenCalledTimes(2);
  });
});
