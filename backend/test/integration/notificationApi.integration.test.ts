import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { CATEGORIES, TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { addComment, transitionTicket } from '../../src/db/services/ticketService.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);
const SECRET = 'INTERNAL-ONLY-secret-note';

interface Res {
  status: number;
  // Responses are asserted field by field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: { data: any; details: unknown };
}

describe.skipIf(!testDatabaseUrl)('notification API (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (
    as: string | null,
    method: 'GET' | 'PATCH' | 'POST',
    url: string,
  ): Promise<Res> => {
    const res = await app.inject({ method, url, headers: as ? await bearer(as) : {} });
    return { status: res.statusCode, body: res.json() };
  };
  const list = (as: string | null, qs = '') => call(as, 'GET', `/api/notifications${qs}`);

  const makeTicket = (requesterId: string) =>
    prisma.ticket.create({
      data: {
        requesterId,
        title: 'Notify target',
        description: 'd',
        status: 'IN_PROGRESS',
        categoryId: CATEGORIES.network,
        priority: 'HIGH',
        assignedTeamId: TEAMS.network,
        assigneeId: USERS.tara,
      },
    });
  /** Technician replies `n` times on a ticket of `requesterId`: `n` notifications for them. */
  const reply = async (ticketId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await addComment(prisma, { ticketId, authorId: USERS.tara, body: `Update ${i}` });
    }
  };

  beforeAll(async () => {
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
      logger: false,
    });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await app.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('requires authentication', async () => {
    expect((await list(null)).status).toBe(401);
    expect((await call(null, 'POST', '/api/notifications/read-all')).status).toBe(401);
  });

  it('returns an empty page for a user with no notifications', async () => {
    const r = await list(USERS.erin);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
      nextOffset: null,
      unreadCount: 0,
    });
  });

  it('lists only the caller own notifications, with safe fixed wording', async () => {
    const mine = await makeTicket(USERS.erin);
    const theirs = await makeTicket(USERS.omar);
    await addComment(prisma, {
      ticketId: mine.id,
      authorId: USERS.tara,
      body: SECRET,
      isInternal: true,
    });
    await transitionTicket(prisma, {
      ticketId: mine.id,
      actorId: USERS.tara,
      to: 'RESOLVED',
      resolutionSummary: 'Replaced the cable',
    });
    await reply(theirs.id, 2);

    const erin = await list(USERS.erin);
    expect(erin.body.data.total).toBe(1);
    expect(erin.body.data.items[0]).toMatchObject({
      type: 'TICKET_RESOLVED',
      message: 'Your ticket was resolved.',
      ticketId: mine.id,
      trackingId: mine.id,
      ticketTitle: 'Notify target',
      read: false,
      readAt: null,
    });
    expect(JSON.stringify(erin.body)).not.toContain(SECRET);
    expect(JSON.stringify(erin.body)).not.toContain('Replaced the cable');

    const omar = await list(USERS.omar);
    expect(omar.body.data.total).toBe(2);
    expect(omar.body.data.items.every((n: { ticketId: string }) => n.ticketId === theirs.id)).toBe(
      true,
    );
  });

  it('pages newest first without repeats or gaps', async () => {
    const t = await makeTicket(USERS.erin);
    await reply(t.id, 5);
    const all = (await list(USERS.erin, '?limit=100')).body.data.items.map(
      (n: { id: string }) => n.id,
    );
    expect(all).toHaveLength(5);
    const created = (await list(USERS.erin)).body.data.items.map(
      (n: { createdAt: string }) => n.createdAt,
    );
    expect([...created].sort().reverse()).toEqual(created);

    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Res = await list(USERS.erin, `?limit=2&offset=${offset}`);
      expect(page.body.data.total).toBe(5);
      seen.push(...page.body.data.items.map((n: { id: string }) => n.id));
      offset = page.body.data.nextOffset;
    }
    expect(seen).toEqual(all);
  });

  it('rejects bad query parameters', async () => {
    expect((await list(USERS.erin, '?limit=0')).status).toBe(400);
    expect((await list(USERS.erin, '?limit=101')).status).toBe(400);
    expect((await list(USERS.erin, '?offset=-1')).status).toBe(400);
    expect((await list(USERS.erin, '?unreadOnly=maybe')).status).toBe(400);
    expect((await list(USERS.erin, '?recipientId=x')).status).toBe(400);
  });

  it('keeps the unread count and listing consistent after mark-read', async () => {
    const t = await makeTicket(USERS.erin);
    await reply(t.id, 3);
    const before = (await list(USERS.erin)).body.data;
    expect(before.unreadCount).toBe(3);

    const first = before.items[0].id;
    const r = await call(USERS.erin, 'PATCH', `/api/notifications/${first}/read`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ unreadCount: 2 });

    const after = (await list(USERS.erin)).body.data;
    expect(after.unreadCount).toBe(2);
    expect(after.total).toBe(3);
    expect(after.items.find((n: { id: string }) => n.id === first)).toMatchObject({ read: true });

    const unread = (await list(USERS.erin, '?unreadOnly=true')).body.data;
    expect(unread.total).toBe(2);
    expect(unread.unreadCount).toBe(2);
    expect(unread.items.map((n: { id: string }) => n.id)).not.toContain(first);
  });

  it('is idempotent and keeps the first read time', async () => {
    const t = await makeTicket(USERS.erin);
    await reply(t.id, 1);
    const id = (await list(USERS.erin)).body.data.items[0].id;
    expect((await call(USERS.erin, 'PATCH', `/api/notifications/${id}/read`)).status).toBe(200);
    const firstRead = (await prisma.notification.findUniqueOrThrow({ where: { id } })).readAt;
    expect(firstRead).not.toBeNull();
    const again = await call(USERS.erin, 'PATCH', `/api/notifications/${id}/read`);
    expect(again.status).toBe(200);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).readAt).toEqual(
      firstRead,
    );
  });

  it('survives concurrent mark-read calls', async () => {
    const t = await makeTicket(USERS.erin);
    await reply(t.id, 1);
    const id = (await list(USERS.erin)).body.data.items[0].id;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(USERS.erin, 'PATCH', `/api/notifications/${id}/read`)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await list(USERS.erin)).body.data.unreadCount).toBe(0);
  });

  it('hides other users notifications behind a 404 and leaves them unread', async () => {
    const t = await makeTicket(USERS.erin);
    await reply(t.id, 1);
    const id = (await list(USERS.erin)).body.data.items[0].id;
    const r = await call(USERS.omar, 'PATCH', `/api/notifications/${id}/read`);
    expect(r.status).toBe(404);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).readAt).toBeNull();
    expect((await call(USERS.erin, 'PATCH', `/api/notifications/${USERS.erin}/read`)).status).toBe(
      404,
    );
    expect((await call(USERS.erin, 'PATCH', '/api/notifications/not-a-uuid/read')).status).toBe(
      400,
    );
  });

  it('marks only the caller own notifications read with read-all', async () => {
    await reply((await makeTicket(USERS.erin)).id, 2);
    await reply((await makeTicket(USERS.omar)).id, 2);
    const r = await call(USERS.erin, 'POST', '/api/notifications/read-all');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ unreadCount: 0, updated: 2 });
    expect((await list(USERS.omar)).body.data.unreadCount).toBe(2);
    const again = await call(USERS.erin, 'POST', '/api/notifications/read-all');
    expect(again.body.data).toEqual({ unreadCount: 0, updated: 0 });
  });
});
