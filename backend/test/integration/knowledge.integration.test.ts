import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { ARTICLES, CATEGORIES, RECOMMENDATIONS, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

describe.skipIf(!testDatabaseUrl)('knowledge articles (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (as: string | null, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, headers: as ? await bearer(as) : {}, payload });
  const admin = (method: Method, url: string, payload?: object) =>
    call(USERS.admin, method, `/api/admin/knowledge${url}`, payload);
  const read = (as: string | null, url: string) => call(as, 'GET', `/api/knowledge${url}`);

  beforeAll(async () => {
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      logger: false,
      authRateLimit: { login: 10_000, refresh: 10_000, windowMs: 60_000 },
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

  describe('role matrix', () => {
    const adminEndpoints = [
      ['GET', '/'],
      ['POST', '/'],
      ['GET', `/${ARTICLES.draft}`],
      ['PATCH', `/${ARTICLES.draft}`],
      ['POST', `/${ARTICLES.draft}/publish`],
      ['POST', `/${ARTICLES.vpn}/unpublish`],
    ] as const;

    it.each(adminEndpoints)('anonymous %s %s is 401', async (method, url) => {
      expect((await call(null, method, `/api/admin/knowledge${url}`, {})).statusCode).toBe(401);
    });

    it.each(adminEndpoints)(
      'employee and technician %s %s are 403 and change nothing',
      async (method, url) => {
        for (const who of [USERS.erin, USERS.tara]) {
          const res = await call(who, method, `/api/admin/knowledge${url}`, {
            title: 'Hijack',
            body: 'Hijack',
          });
          expect(res.statusCode).toBe(403);
        }
        const vpn = await prisma.knowledgeArticle.findUniqueOrThrow({
          where: { id: ARTICLES.vpn },
        });
        const draft = await prisma.knowledgeArticle.findUniqueOrThrow({
          where: { id: ARTICLES.draft },
        });
        expect(vpn.isPublished).toBe(true);
        expect(draft.isPublished).toBe(false);
        expect(await prisma.knowledgeArticle.count()).toBe(5);
      },
    );

    it('readers require authentication', async () => {
      expect((await read(null, '')).statusCode).toBe(401);
      expect((await read(null, `/${ARTICLES.vpn}`)).statusCode).toBe(401);
    });
  });

  describe('reader API', () => {
    it.each([USERS.erin, USERS.tara, USERS.admin])(
      '%s lists published articles only',
      async (who) => {
        const res = await read(who, '');
        expect(res.statusCode).toBe(200);
        const { items, total } = res.json().data;
        expect(total).toBe(4);
        expect(items.map((a: { id: string }) => a.id)).not.toContain(ARTICLES.draft);
        // Summaries carry no body.
        expect(items[0]).not.toHaveProperty('body');
        expect(items[0]).not.toHaveProperty('isPublished');
      },
    );

    it('returns a published article with its category', async () => {
      const res = await read(USERS.erin, `/${ARTICLES.vpn}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        id: ARTICLES.vpn,
        category: { id: CATEGORIES.network },
      });
      expect(res.json().data).not.toHaveProperty('isPublished');
    });

    it('a draft cannot be fetched by guessing its id, for any role', async () => {
      const missing = await read(USERS.erin, '/00000000-0000-4000-8000-000000000000');
      for (const who of [USERS.erin, USERS.tara, USERS.admin]) {
        const res = await read(who, `/${ARTICLES.draft}`);
        expect(res.statusCode).toBe(404);
        // Indistinguishable from an id that does not exist, and leaks nothing of the draft.
        expect(res.json()).toEqual(missing.json());
        expect(res.body).not.toContain('onboarding');
      }
    });

    it('filters by category and pages deterministically', async () => {
      const byCategory = await read(USERS.erin, `?categoryId=${CATEGORIES.network}`);
      expect(byCategory.json().data.items.map((a: { id: string }) => a.id)).toEqual([ARTICLES.vpn]);

      const first = (await read(USERS.erin, '?limit=2')).json().data;
      expect(first).toMatchObject({ total: 4, limit: 2, offset: 0, nextOffset: 2 });
      const second = (await read(USERS.erin, '?limit=2&offset=2')).json().data;
      expect(second.nextOffset).toBeNull();
      const ids = [...first.items, ...second.items].map((a: { id: string }) => a.id);
      expect(new Set(ids).size).toBe(4);
      const past = (await read(USERS.erin, '?offset=50')).json().data;
      expect(past).toMatchObject({ items: [], total: 4, nextOffset: null });
    });

    it.each(['?limit=0', '?limit=51', '?offset=-1', '?categoryId=nope', '?limit=abc'])(
      'rejects bad query %s',
      async (qs) => {
        expect((await read(USERS.erin, qs)).statusCode).toBe(400);
      },
    );

    it('a malformed id is 400, not a server error', async () => {
      expect((await read(USERS.erin, '/not-a-uuid')).statusCode).toBe(400);
    });
  });

  describe('administration', () => {
    it('creates a draft, which readers cannot see until it is published', async () => {
      const created = await admin('POST', '', {
        title: '  Reset your badge  ',
        body: 'Visit the front desk.',
        categoryId: CATEGORIES.access,
      });
      expect(created.statusCode).toBe(201);
      const draft = created.json().data;
      expect(draft).toMatchObject({
        title: 'Reset your badge',
        isPublished: false,
        category: { id: CATEGORIES.access },
      });

      expect((await read(USERS.erin, `/${draft.id}`)).statusCode).toBe(404);
      expect((await read(USERS.erin, '')).json().data.total).toBe(4);
      // The admin list does show it.
      const all = (await admin('GET', '?published=false')).json().data;
      expect(all.items.map((a: { id: string }) => a.id).sort()).toEqual(
        [draft.id, ARTICLES.draft].sort(),
      );

      const published = await admin('POST', `/${draft.id}/publish`);
      expect(published.statusCode).toBe(200);
      expect(published.json().data.isPublished).toBe(true);

      const seen = await read(USERS.erin, `/${draft.id}`);
      expect(seen.statusCode).toBe(200);
      expect(seen.json().data.title).toBe('Reset your badge');
      expect((await read(USERS.erin, '')).json().data.total).toBe(5);
    });

    it('publish and unpublish are idempotent and bump updatedAt only on change', async () => {
      const before = await prisma.knowledgeArticle.findUniqueOrThrow({
        where: { id: ARTICLES.vpn },
      });
      const again = await admin('POST', `/${ARTICLES.vpn}/publish`);
      expect(again.statusCode).toBe(200);
      const same = await prisma.knowledgeArticle.findUniqueOrThrow({ where: { id: ARTICLES.vpn } });
      expect(same.updatedAt).toEqual(before.updatedAt);

      expect((await admin('POST', `/${ARTICLES.vpn}/unpublish`)).statusCode).toBe(200);
      const after = await prisma.knowledgeArticle.findUniqueOrThrow({
        where: { id: ARTICLES.vpn },
      });
      expect(after.isPublished).toBe(false);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect((await admin('POST', `/${ARTICLES.vpn}/unpublish`)).statusCode).toBe(200);
    });

    it('unpublishing hides the article from readers but keeps recommendation references', async () => {
      const linkedBefore = await prisma.recommendationArticle.count({
        where: { articleId: ARTICLES.vpn },
      });
      expect(linkedBefore).toBeGreaterThan(0);

      expect((await admin('POST', `/${ARTICLES.vpn}/unpublish`)).statusCode).toBe(200);

      expect((await read(USERS.erin, `/${ARTICLES.vpn}`)).statusCode).toBe(404);
      expect(
        (await read(USERS.erin, '')).json().data.items.map((a: { id: string }) => a.id),
      ).not.toContain(ARTICLES.vpn);
      expect(await prisma.recommendationArticle.count({ where: { articleId: ARTICLES.vpn } })).toBe(
        linkedBefore,
      );
      const link = await prisma.recommendationArticle.findFirstOrThrow({
        where: { recommendationId: RECOMMENDATIONS.vpnAccepted, articleId: ARTICLES.vpn },
      });
      expect(link.articleId).toBe(ARTICLES.vpn);

      // Administrators can still read it, and it can come back.
      expect((await admin('GET', `/${ARTICLES.vpn}`)).json().data.isPublished).toBe(false);
      expect((await admin('POST', `/${ARTICLES.vpn}/publish`)).statusCode).toBe(200);
      expect((await read(USERS.erin, `/${ARTICLES.vpn}`)).statusCode).toBe(200);
    });

    it('a referenced article cannot be deleted from the database', async () => {
      await expect(
        prisma.knowledgeArticle.delete({ where: { id: ARTICLES.vpn } }),
      ).rejects.toThrow();
      expect(await prisma.knowledgeArticle.count({ where: { id: ARTICLES.vpn } })).toBe(1);
    });

    it('there is no delete endpoint', async () => {
      const res = await admin('DELETE', `/${ARTICLES.draft}`);
      expect(res.statusCode).toBe(404);
      expect(await prisma.knowledgeArticle.count({ where: { id: ARTICLES.draft } })).toBe(1);
    });

    it('updates title, body and category together', async () => {
      const res = await admin('PATCH', `/${ARTICLES.draft}`, {
        title: 'Laptop onboarding',
        body: 'Step 1.\r\nStep 2.',
        categoryId: CATEGORIES.software,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        title: 'Laptop onboarding',
        body: 'Step 1.\nStep 2.',
        category: { id: CATEGORIES.software },
        isPublished: false,
      });
      const cleared = await admin('PATCH', `/${ARTICLES.draft}`, { categoryId: null });
      expect(cleared.json().data.category).toBeNull();
    });

    it('validates content and category, leaving the article untouched on failure', async () => {
      const before = await prisma.knowledgeArticle.findUniqueOrThrow({
        where: { id: ARTICLES.draft },
      });
      const bad: object[] = [
        { title: '   ' },
        { body: '' },
        { title: 'x'.repeat(201) },
        { body: 'x'.repeat(20_001) },
        { title: '\u0000\u0007' },
        { categoryId: 'nope' },
        { unknown: 1 },
        {},
      ];
      for (const payload of bad) {
        expect(
          (await admin('PATCH', `/${ARTICLES.draft}`, payload)).statusCode,
        ).toBeGreaterThanOrEqual(400);
      }
      // Valid title but an inactive category: the title must not be applied either.
      const inactive = await admin('PATCH', `/${ARTICLES.draft}`, {
        title: 'Partial',
        categoryId: CATEGORIES.legacy,
      });
      expect(inactive.statusCode).toBe(422);
      const unknown = await admin('PATCH', `/${ARTICLES.draft}`, {
        title: 'Partial',
        categoryId: '00000000-0000-4000-8000-000000000000',
      });
      expect(unknown.statusCode).toBe(422);

      const after = await prisma.knowledgeArticle.findUniqueOrThrow({
        where: { id: ARTICLES.draft },
      });
      expect(after).toEqual(before);
    });

    it('rejects an invalid category on create and creates nothing', async () => {
      for (const categoryId of [CATEGORIES.legacy, '00000000-0000-4000-8000-000000000000']) {
        const res = await admin('POST', '', { title: 'T', body: 'B', categoryId });
        expect(res.statusCode).toBe(422);
      }
      expect((await admin('POST', '', { title: 'T' })).statusCode).toBe(400);
      expect(await prisma.knowledgeArticle.count()).toBe(5);
    });

    it('allows an article without a category', async () => {
      const res = await admin('POST', '', { title: 'General tip', body: 'Restart it.' });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.category).toBeNull();
    });

    it('stores markup as inert text and strips control characters', async () => {
      const res = await admin('POST', '', {
        title: 'Tips <script>alert(1)</script>',
        body: 'Hello\u0000 <img src=x onerror=alert(1)>\u0007 world',
      });
      expect(res.statusCode).toBe(201);
      const { id, body, title } = res.json().data;
      expect(body).toBe('Hello <img src=x onerror=alert(1)> world');
      expect(title).toBe('Tips <script>alert(1)</script>');
      // JSON, never HTML: the response cannot be sniffed into a document.
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      await admin('POST', `/${id}/publish`);
      const read2 = await read(USERS.erin, `/${id}`);
      expect(read2.headers['content-type']).toMatch(/^application\/json/);
    });

    it('cannot publish into an inactive category', async () => {
      await prisma.knowledgeArticle.update({
        where: { id: ARTICLES.draft },
        data: { categoryId: CATEGORIES.legacy },
      });
      const res = await admin('POST', `/${ARTICLES.draft}/publish`);
      expect(res.statusCode).toBe(409);
      expect(
        (await prisma.knowledgeArticle.findUniqueOrThrow({ where: { id: ARTICLES.draft } }))
          .isPublished,
      ).toBe(false);
    });

    it('unknown articles are 404 and bad ids 400 for administrators', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000';
      expect((await admin('GET', `/${ghost}`)).statusCode).toBe(404);
      expect((await admin('PATCH', `/${ghost}`, { title: 'x' })).statusCode).toBe(404);
      expect((await admin('POST', `/${ghost}/publish`)).statusCode).toBe(404);
      expect((await admin('GET', '/not-a-uuid')).statusCode).toBe(400);
    });
  });
});
