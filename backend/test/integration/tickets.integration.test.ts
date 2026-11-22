import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { approveRouting } from '../../src/db/services/ticketService.js';
import { USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);
const KEY = 'retry-key-0001-abcdef';

describe.skipIf(!testDatabaseUrl)('POST /api/tickets (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const post = async (as: string | null, payload: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { ...(as ? await bearer(as) : {}), ...extra },
      payload: payload as object,
    });
  const valid = { title: 'Printer jams', description: 'Tray 2 jams on every second page.' };
  const counts = async () => ({
    tickets: await prisma.ticket.count(),
    events: await prisma.ticketEvent.count(),
  });

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

  it('creates an OPEN/UNSET ticket with a matching CREATED event', async () => {
    const before = await counts();
    const res = await post(USERS.erin, {
      title: '  Printer jams ',
      description: valid.description,
    });
    expect(res.statusCode).toBe(201);
    const t = res.json().data;
    expect(t).toMatchObject({
      title: 'Printer jams',
      status: 'OPEN',
      priority: 'UNSET',
      categoryId: null,
      teamId: null,
      assigneeId: null,
      requesterId: USERS.erin,
      resolutionSummary: null,
      version: 1,
    });
    expect(t.trackingId).toBe(t.id);
    expect(new Date(t.createdAt).getTime()).toBeLessThanOrEqual(Date.now());

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: t.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'CREATED', actorId: USERS.erin });
    expect(await counts()).toEqual({ tickets: before.tickets + 1, events: before.events + 1 });
  });

  it('requires authentication', async () => {
    const before = await counts();
    expect((await post(null, valid)).statusCode).toBe(401);
    expect(await counts()).toEqual(before);
  });

  it.each([
    ['blank title', { ...valid, title: '   ' }],
    ['title over 150', { ...valid, title: 'x'.repeat(151) }],
    ['blank description', { ...valid, description: ' \n ' }],
    ['description over cap', { ...valid, description: 'x'.repeat(5001) }],
    ['missing title', { description: valid.description }],
    ['non-string title', { ...valid, title: 42 }],
    ['role', { ...valid, role: 'ADMIN' }],
    ['requesterId', { ...valid, requesterId: USERS.omar }],
    ['status', { ...valid, status: 'RESOLVED' }],
    ['priority', { ...valid, priority: 'CRITICAL' }],
    ['assigneeId', { ...valid, assigneeId: USERS.tara }],
    ['teamId', { ...valid, teamId: USERS.tara }],
  ])('rejects %s without writing anything', async (_name, payload) => {
    const before = await counts();
    const res = await post(USERS.erin, payload);
    expect(res.statusCode).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it('accepts a 150 character title', async () => {
    expect((await post(USERS.erin, { ...valid, title: 'x'.repeat(150) })).statusCode).toBe(201);
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const res = await post(USERS.erin, valid, { 'idempotency-key': 'short' });
    expect(res.statusCode).toBe(400);
  });

  it('never leaves a partial ticket or orphan event when the audit write fails', async () => {
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced failure'; END $fn$",
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER trg_fail_event BEFORE INSERT ON ticket_events FOR EACH ROW EXECUTE FUNCTION fail_event()',
    );
    try {
      const before = await counts();
      const res = await post(USERS.erin, valid);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await counts()).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER trg_fail_event ON ticket_events');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_event()');
    }
  });

  describe('duplicate submissions', () => {
    it('returns the original ticket for a retry with the same key', async () => {
      const first = await post(USERS.erin, valid, { 'idempotency-key': KEY });
      const before = await counts();
      const retry = await post(USERS.erin, valid, { 'idempotency-key': KEY });
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(retry.json().data.id).toBe(first.json().data.id);
      expect(await counts()).toEqual(before);
    });

    it('rejects the same key with a different payload', async () => {
      await post(USERS.erin, valid, { 'idempotency-key': KEY });
      const before = await counts();
      const res = await post(
        USERS.erin,
        { ...valid, title: 'Something else' },
        { 'idempotency-key': KEY },
      );
      expect(res.statusCode).toBe(409);
      expect(await counts()).toEqual(before);
    });

    it('scopes keys per requester', async () => {
      const a = await post(USERS.erin, valid, { 'idempotency-key': KEY });
      const b = await post(USERS.omar, valid, { 'idempotency-key': KEY });
      expect(b.statusCode).toBe(201);
      expect(b.json().data.id).not.toBe(a.json().data.id);
    });

    it('creates one ticket when the same key is submitted concurrently', async () => {
      const before = await counts();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => post(USERS.erin, valid, { 'idempotency-key': KEY })),
      );
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.every((c) => c === 200 || c === 201)).toBe(true);
      expect(new Set(results.map((r) => r.json().data.id)).size).toBe(1);
      expect(await counts()).toEqual({ tickets: before.tickets + 1, events: before.events + 1 });
    });

    it('creates distinct tickets for concurrent requests without a key', async () => {
      const before = await counts();
      const results = await Promise.all(Array.from({ length: 6 }, () => post(USERS.omar, valid)));
      expect(results.every((r) => r.statusCode === 201)).toBe(true);
      expect(new Set(results.map((r) => r.json().data.id)).size).toBe(6);
      expect(await counts()).toEqual({ tickets: before.tickets + 6, events: before.events + 6 });
    });
  });

  it('works with AI disabled (no AI module is involved in submission)', async () => {
    expect((await post(USERS.erin, valid)).statusCode).toBe(201);
  });

  it('bumps the concurrency version on later mutations', async () => {
    const created = (await post(USERS.erin, valid)).json().data;
    await approveRouting(prisma, { ticketId: created.id, actorId: USERS.admin, priority: 'HIGH' });
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.version).toBe(2);
  });
});
