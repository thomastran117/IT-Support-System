import { randomUUID } from 'node:crypto';
import {
  AI_JOB_PATH,
  AI_JOB_SCOPES,
  analysisInputsV1Schema,
  analysisJobClaimV1Schema,
  type AnalysisJobIdentityV1,
} from '@smartdesk/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { ARTICLES, CATEGORIES, TEAMS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createServiceFixture } from '../fixtures/serviceCredentials.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('AI service Ticket boundary (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;
  let tokens: TokenService;
  let caller: Awaited<ReturnType<typeof createServiceFixture>>;
  const secret = 'vpn-person@example.test';

  beforeAll(async () => {
    caller = await createServiceFixture('ai-test', 'ai');
    const { claim, inputs, complete, fail } = AI_JOB_SCOPES;
    const env = loadEnv({
      AI_EXECUTION_MODE: 'service',
      AI_PROVIDER: 'fake',
      INTERNAL_SERVICE_KEYS: JSON.stringify([
        {
          ...caller.config,
          grants: { [claim]: 'system', [inputs]: 'system', [complete]: 'system', [fail]: 'system' },
        },
      ]),
    });
    tokens = new TokenService(env);
    app = await buildApp({
      env,
      prisma,
      logger: false,
      checkDb: async () => true,
      checkCache: async () => 'disabled',
    });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await app?.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  async function internal(
    operation: keyof typeof AI_JOB_SCOPES,
    payload?: object,
    scope = AI_JOB_SCOPES[operation],
  ) {
    const token = await caller.sign({ scope });
    return app.inject({
      method: 'POST',
      url: `${AI_JOB_PATH}/${operation}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  }

  async function publicPost(userId: string, url: string, payload: object) {
    return app.inject({
      method: 'POST',
      url,
      payload,
      headers: { authorization: `Bearer ${await tokens.sign('access', userId, 0)}` },
    });
  }

  async function submit() {
    const res = await publicPost(USERS.erin, '/api/tickets', {
      title: 'VPN disconnects',
      description: `VPN fails during reconnect. Contact ${secret}`,
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ data: { id: string; version: number } }>().data;
  }

  async function claim() {
    const res = await internal('claim');
    expect(res.statusCode).toBe(200);
    const { attempts, ...identity } = analysisJobClaimV1Schema.parse(res.json());
    return { attempts, identity };
  }

  const command = (identity: AnalysisJobIdentityV1, citedArticleIds: string[] = []) => ({
    ...identity,
    promptVersion: 'v42',
    draft: {
      categoryId: CATEGORIES.network,
      teamId: TEAMS.network,
      priority: 'HIGH',
      troubleshooting: 'Reconnect and check VPN client logs.',
      confidence: 0.8,
      modelVersion: 'fake:test',
      citedArticleIds,
    },
  });

  it('queues without a provider and only releases redacted, lease-scoped knowledge inputs', async () => {
    await prisma.knowledgeArticle.update({
      where: { id: ARTICLES.vpn },
      data: { body: `VPN reconnect troubleshooting for ${secret}` },
    });
    const ticket = await submit();
    expect(await prisma.aiAnalysisJob.findFirst({ where: { ticketId: ticket.id } })).toMatchObject({
      state: 'QUEUED',
      attempts: 0,
    });
    expect((await app.inject({ method: 'POST', url: `${AI_JOB_PATH}/claim` })).statusCode).toBe(
      401,
    );
    expect((await internal('claim', undefined, AI_JOB_SCOPES.inputs)).statusCode).toBe(403);
    const { identity } = await claim();
    expect(identity.ticketId).toBe(ticket.id);
    expect((await internal('inputs', { ...identity, ticketId: randomUUID() })).statusCode).toBe(
      409,
    );
    expect((await internal('inputs', { ...identity, requestId: randomUUID() })).statusCode).toBe(
      409,
    );

    const response = await internal('inputs', identity);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const input = analysisInputsV1Schema.parse(response.json());
    expect(input.ticket.description).toContain('[REDACTED_EMAIL]');
    expect(input.articles).toContainEqual(
      expect.objectContaining({
        id: ARTICLES.vpn,
        body: expect.stringContaining('[REDACTED_EMAIL]'),
      }),
    );
    expect(input.allowedCategories.map((row) => row.id)).not.toContain(CATEGORIES.legacy);
    expect(input.allowedTeams.map((row) => row.id)).not.toContain(TEAMS.legacy);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain(USERS.erin);
    const published = await prisma.knowledgeArticle.count({
      where: { id: { in: input.articles.map((row) => row.id) }, isPublished: true },
    });
    expect(published).toBe(input.articles.length);
  });

  it('fences expired and replaced leases, retries safely and commits one immutable result', async () => {
    const ticket = await submit();
    const first = await claim();
    const where = { id: first.identity.jobId };
    await prisma.aiAnalysisJob.update({
      where,
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    expect((await internal('complete', command(first.identity))).statusCode).toBe(409);
    expect((await internal('fail', { ...first.identity, kind: 'timeout' })).statusCode).toBe(409);
    const second = await claim();
    expect(second.attempts).toBe(2);
    expect(second.identity.leaseToken).not.toBe(first.identity.leaseToken);
    expect((await internal('inputs', first.identity)).statusCode).toBe(409);
    const failed = await internal('fail', { ...second.identity, kind: 'timeout' });
    expect(failed.json()).toEqual({ state: 'QUEUED' });
    expect((await internal('claim')).statusCode).toBe(204);
    expect(await prisma.aiAnalysisJob.findUnique({ where })).toMatchObject({
      state: 'QUEUED',
      errorKind: 'timeout',
      leaseToken: null,
    });
    await prisma.aiAnalysisJob.update({ where, data: { runAfter: new Date(Date.now() - 1000) } });
    const third = await claim();
    expect(third.attempts).toBe(3);
    const invalid = await internal('complete', command(third.identity, [randomUUID()]));
    expect(invalid.statusCode).toBe(422);
    expect(await prisma.aiAnalysisJob.findUnique({ where })).toMatchObject({ state: 'RUNNING' });

    const finish = command(third.identity, [ARTICLES.vpn]);
    expect((await internal('complete', finish)).statusCode).toBe(204);
    const duplicate = {
      ...finish,
      draft: { ...finish.draft, troubleshooting: 'A different draft' },
    };
    expect((await internal('complete', duplicate)).statusCode).toBe(204);
    expect((await internal('complete', { ...duplicate, requestId: randomUUID() })).statusCode).toBe(
      409,
    );
    expect(await prisma.aiAnalysisJob.findUnique({ where })).toMatchObject({
      state: 'COMPLETED',
      attempts: 3,
      errorKind: null,
    });
    const recs = await prisma.aiRecommendation.findMany({
      where: { ticketId: ticket.id },
      include: { articles: true },
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      reviewStatus: 'PENDING',
      suggestion: finish.draft.troubleshooting,
      modelVersion: 'fake:test@prompt-v42',
      articles: [{ articleId: ARTICLES.vpn }],
    });
    expect(
      await prisma.serviceOutboxEvent.count({
        where: { aggregateId: ticket.id, type: 'recommendation.ready' },
      }),
    ).toBe(1);
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      status: 'OPEN',
      categoryId: null,
      assignedTeamId: null,
      priority: 'UNSET',
      version: ticket.version,
    });
    const review = await publicPost(
      USERS.admin,
      `/api/tickets/${ticket.id}/recommendations/${recs[0]!.id}/review`,
      {
        expectedVersion: ticket.version,
        decision: 'ACCEPTED',
      },
    );
    expect(review.statusCode).toBe(200);
    expect(await prisma.aiRecommendation.findUnique({ where: { id: recs[0]!.id } })).toMatchObject({
      reviewStatus: 'ACCEPTED',
      reviewerId: USERS.admin,
    });
  });

  it('keeps manual routing usable while the separate AI process is unavailable', async () => {
    const ticket = await submit();
    const routed = await publicPost(USERS.admin, `/api/tickets/${ticket.id}/routing`, {
      teamId: TEAMS.network,
      categoryId: CATEGORIES.network,
      priority: 'MEDIUM',
      expectedVersion: ticket.version,
    });
    expect(routed.statusCode).toBe(200);
    expect(routed.json()).toMatchObject({ data: { status: 'TRIAGED' } });
    expect(await prisma.aiAnalysisJob.findFirst({ where: { ticketId: ticket.id } })).toMatchObject({
      state: 'QUEUED',
      attempts: 0,
    });
  });
});
