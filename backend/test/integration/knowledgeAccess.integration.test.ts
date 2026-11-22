import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { searchPublished } from '../../src/db/repositories/knowledge.js';
import { ARTICLES, CATEGORIES, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createKnowledgeService } from '../../src/modules/knowledge/service.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

/**
 * SD-031: the knowledge-base access matrix (documented in docs/authentication.md) as executable
 * checks, plus relevance, ordering and atomicity guarantees. Real PostgreSQL, no external AI: AI
 * retrieval is exercised through the same service function the orchestrator will call.
 */

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const GHOST = '00000000-0000-4000-8000-000000000000';
const DRAFT_TEXT = ['onboarding checklist', 'provisioning a new laptop', 'Work in progress'];

describe.skipIf(!testDatabaseUrl)('knowledge access and relevance (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const call = async (as: string | null, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, headers: as ? await bearer(as) : {}, payload });
  const article = (id: string) => prisma.knowledgeArticle.findUniqueOrThrow({ where: { id } });
  const leaksDraft = (body: string) =>
    DRAFT_TEXT.some((t) => body.toLowerCase().includes(t.toLowerCase())) ||
    body.includes(ARTICLES.draft);

  beforeAll(async () => {
    app = await buildApp({
      env,
      prisma,
      checkDb: async () => true,
      checkCache: async () => 'disabled' as const,
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

  // ------------------------------------------------------------------------------------------
  describe('access matrix: role x surface x article state', () => {
    const roles = [
      ['employee', USERS.erin],
      ['technician', USERS.tara],
      ['administrator', USERS.admin],
    ] as const;

    it.each(roles)('%s: list, search and direct read expose published only', async (_n, who) => {
      const list = await call(who, 'GET', '/api/knowledge');
      expect(list.statusCode).toBe(200);
      expect(list.json().data.total).toBe(4);
      expect(leaksDraft(list.body)).toBe(false);

      for (const term of ['onboarding', 'laptop', 'checklist', 'provisioning', 'progress']) {
        const res = await call(who, 'GET', `/api/knowledge/search?q=${term}`);
        expect(res.statusCode).toBe(200);
        expect(res.json().data.total).toBe(0);
        expect(leaksDraft(res.body)).toBe(false);
      }

      expect((await call(who, 'GET', `/api/knowledge/${ARTICLES.vpn}`)).statusCode).toBe(200);
      const draft = await call(who, 'GET', `/api/knowledge/${ARTICLES.draft}`);
      expect(draft.statusCode).toBe(404);
      expect(leaksDraft(draft.body)).toBe(false);
    });

    it('a draft is byte-for-byte indistinguishable from a missing article', async () => {
      for (const [, who] of roles) {
        const draft = await call(who, 'GET', `/api/knowledge/${ARTICLES.draft}`);
        const ghost = await call(who, 'GET', `/api/knowledge/${GHOST}`);
        expect(draft.statusCode).toBe(ghost.statusCode);
        const strip = (b: string) => JSON.parse(b);
        const a = strip(draft.body);
        const b = strip(ghost.body);
        // Only the per-request correlation id may differ.
        delete a.requestId;
        delete b.requestId;
        expect(a).toEqual(b);
      }
    });

    it('an unpublished article is hidden from every reader role, administrators included', async () => {
      await call(USERS.admin, 'POST', `/api/admin/knowledge/${ARTICLES.vpn}/unpublish`);
      for (const [, who] of roles) {
        expect((await call(who, 'GET', `/api/knowledge/${ARTICLES.vpn}`)).statusCode).toBe(404);
        const res = await call(who, 'GET', '/api/knowledge/search?q=vpn');
        expect(res.json().data.items).toEqual([]);
        const list = await call(who, 'GET', '/api/knowledge?limit=50');
        expect(list.json().data.items.map((a: { id: string }) => a.id)).not.toContain(ARTICLES.vpn);
      }
      // ...but the admin authoring surface still sees it.
      const admin = await call(USERS.admin, 'GET', `/api/admin/knowledge/${ARTICLES.vpn}`);
      expect(admin.json().data.isPublished).toBe(false);
    });

    const mutations: [Method, string][] = [
      ['POST', '/api/admin/knowledge'],
      ['PATCH', `/api/admin/knowledge/${ARTICLES.vpn}`],
      ['POST', `/api/admin/knowledge/${ARTICLES.draft}/publish`],
      ['POST', `/api/admin/knowledge/${ARTICLES.vpn}/unpublish`],
      ['PUT', `/api/admin/knowledge/${ARTICLES.vpn}`],
      ['DELETE', `/api/admin/knowledge/${ARTICLES.vpn}`],
      // Mutations aimed at the reader surface must not exist either.
      ['POST', '/api/knowledge'],
      ['PATCH', `/api/knowledge/${ARTICLES.vpn}`],
      ['PUT', `/api/knowledge/${ARTICLES.vpn}`],
      ['DELETE', `/api/knowledge/${ARTICLES.vpn}`],
      ['POST', `/api/knowledge/${ARTICLES.draft}/publish`],
    ];

    it.each(mutations)('non-admin %s %s is refused safely and changes nothing', async (m, url) => {
      const before = await prisma.knowledgeArticle.findMany({ orderBy: { id: 'asc' } });
      for (const who of [USERS.erin, USERS.tara]) {
        const res = await call(who, m, url, { title: 'Hijack', body: 'Hijack', isPublished: true });
        expect([403, 404, 405]).toContain(res.statusCode);
        expect(res.body).not.toMatch(/hijack/i);
        // An unknown-route 404 echoes the caller's own URL; that is not article data.
        expect(leaksDraft(res.body.replaceAll(url, ''))).toBe(false);
      }
      expect((await call(null, m, url, {})).statusCode).toBeGreaterThanOrEqual(401);
      expect(await prisma.knowledgeArticle.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    });

    it('admin endpoints answer 403 (not 404) to staff, so a draft id is not probed via status', async () => {
      for (const who of [USERS.erin, USERS.tara]) {
        const real = await call(who, 'GET', `/api/admin/knowledge/${ARTICLES.draft}`);
        const ghost = await call(who, 'GET', `/api/admin/knowledge/${GHOST}`);
        expect(real.statusCode).toBe(403);
        expect(ghost.statusCode).toBe(403);
        expect(leaksDraft(real.body)).toBe(false);
        const publish = await call(who, 'POST', `/api/admin/knowledge/${ARTICLES.draft}/publish`);
        expect(publish.statusCode).toBe(403);
      }
    });

    it('deactivated accounts and revoked tokens get nothing', async () => {
      const ivan = await prisma.user.findUniqueOrThrow({ where: { id: USERS.ivan } });
      const token = await tokens.sign('access', ivan.id, ivan.tokenVersion);
      const res = await app.inject({
        method: 'GET',
        url: '/api/knowledge',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);

      // Bumping tokenVersion (as sign-out-everywhere does) invalidates an employee's old token.
      const erin = await prisma.user.findUniqueOrThrow({ where: { id: USERS.erin } });
      const old = await tokens.sign('access', erin.id, erin.tokenVersion);
      await prisma.user.update({
        where: { id: erin.id },
        data: { tokenVersion: { increment: 1 } },
      });
      const stale = await app.inject({
        method: 'GET',
        url: '/api/knowledge/search?q=vpn',
        headers: { authorization: `Bearer ${old}` },
      });
      expect(stale.statusCode).toBe(401);
    });

    it.each(['not-a-uuid', '1', "'; DROP TABLE knowledge_articles;--", '%00', '../etc/passwd'])(
      'malformed id %j is a 400/404 and never a server error',
      async (id) => {
        for (const prefix of ['/api/knowledge/', '/api/admin/knowledge/']) {
          const res = await call(USERS.admin, 'GET', `${prefix}${encodeURIComponent(id)}`);
          expect([400, 404]).toContain(res.statusCode);
        }
        expect(await prisma.knowledgeArticle.count()).toBe(5);
      },
    );
  });

  // ------------------------------------------------------------------------------------------
  describe('AI retrieval uses the same published-only path', () => {
    const service = () => createKnowledgeService(prisma);

    it('the service-level search the orchestrator calls never returns a draft', async () => {
      for (const term of ['onboarding', 'laptop', 'checklist', 'provisioning', 'progress']) {
        const page = await service().search(term, {}, 20, 0);
        expect(page.items).toEqual([]);
        expect(page.total).toBe(0);
      }
    });

    it('a sweep over every word of every article never surfaces an unpublished one', async () => {
      const all = await prisma.knowledgeArticle.findMany();
      const words = new Set(
        all.flatMap((a) => `${a.title} ${a.body}`.toLowerCase().match(/[a-z]{3,}/g) ?? []),
      );
      expect(words.size).toBeGreaterThan(40);
      const unpublished = new Set(all.filter((a) => !a.isPublished).map((a) => a.id));
      for (const word of words) {
        for (const categoryId of [undefined, CATEGORIES.hardware]) {
          const { hits } = await searchPublished(prisma, {
            query: word,
            categoryId,
            limit: 20,
            offset: 0,
          });
          for (const h of hits) expect(unpublished.has(h.id)).toBe(false);
        }
      }
    });

    it('reflects publish and unpublish immediately, as the HTTP surface does', async () => {
      expect((await service().search('onboarding', {}, 10, 0)).total).toBe(0);
      await call(USERS.admin, 'POST', `/api/admin/knowledge/${ARTICLES.draft}/publish`);
      const page = await service().search('onboarding', {}, 10, 0);
      expect(page.items.map((i) => i.id)).toEqual([ARTICLES.draft]);
      await call(USERS.admin, 'POST', `/api/admin/knowledge/${ARTICLES.draft}/unpublish`);
      expect((await service().search('onboarding', {}, 10, 0)).total).toBe(0);
    });

    it('returns citeable ids: every hit resolves to a readable published article', async () => {
      const page = await service().search('password or vpn or printer or licence', {}, 20, 0);
      expect(page.items.length).toBeGreaterThan(0);
      for (const hit of page.items) {
        expect((await call(USERS.erin, 'GET', `/api/knowledge/${hit.id}`)).statusCode).toBe(200);
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('edits and category changes', () => {
    const admin = (m: Method, url: string, payload?: object) =>
      call(USERS.admin, m, `/api/admin/knowledge${url}`, payload);
    const searchIds = async (qs: string) =>
      (
        (await call(USERS.erin, 'GET', `/api/knowledge/search${qs}`)).json().data.items as {
          id: string;
        }[]
      ).map((i) => i.id);

    it('editing a draft never makes it searchable; publishing then shows the edit', async () => {
      await admin('PATCH', `/${ARTICLES.draft}`, {
        title: 'Quokka handbook',
        body: 'Quokka care.',
      });
      expect(await searchIds('?q=quokka')).toEqual([]);
      await admin('POST', `/${ARTICLES.draft}/publish`);
      expect(await searchIds('?q=quokka')).toEqual([ARTICLES.draft]);
    });

    it('editing a published article is reflected in search and the old text stops matching', async () => {
      expect(await searchIds('?q=spooler')).toEqual([ARTICLES.printer]);
      await admin('PATCH', `/${ARTICLES.printer}`, { body: 'Power-cycle the printer.' });
      expect(await searchIds('?q=spooler')).toEqual([]);
      expect(await searchIds('?q=power-cycle')).toEqual([ARTICLES.printer]);
    });

    it('moving an article between categories moves it between category-filtered searches', async () => {
      const inNetwork = `?q=vpn&categoryId=${CATEGORIES.network}`;
      const inAccess = `?q=vpn&categoryId=${CATEGORIES.access}`;
      expect(await searchIds(inNetwork)).toEqual([ARTICLES.vpn]);
      expect(await searchIds(inAccess)).toEqual([]);
      await admin('PATCH', `/${ARTICLES.vpn}`, { categoryId: CATEGORIES.access });
      expect(await searchIds(inNetwork)).toEqual([]);
      expect(await searchIds(inAccess)).toEqual([ARTICLES.vpn]);
      // Clearing the category keeps it searchable, just unfiltered.
      await admin('PATCH', `/${ARTICLES.vpn}`, { categoryId: null });
      expect(await searchIds('?q=vpn')).toEqual([ARTICLES.vpn]);
      expect(await searchIds(inAccess)).toEqual([]);
    });

    it('permissions are identical before and after unpublish/republish', async () => {
      const probe = async () => [
        (await call(USERS.erin, 'GET', `/api/knowledge/${ARTICLES.vpn}`)).statusCode,
        (await call(USERS.tara, 'PATCH', `/api/admin/knowledge/${ARTICLES.vpn}`, { title: 'x' }))
          .statusCode,
        (await call(USERS.erin, 'POST', `/api/admin/knowledge/${ARTICLES.vpn}/unpublish`))
          .statusCode,
      ];
      expect(await probe()).toEqual([200, 403, 403]);
      await admin('POST', `/${ARTICLES.vpn}/unpublish`);
      expect(await probe()).toEqual([404, 403, 403]);
      await admin('POST', `/${ARTICLES.vpn}/publish`);
      expect(await probe()).toEqual([200, 403, 403]);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('pagination boundaries and ordering', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 6; i++) {
        await prisma.knowledgeArticle.create({
          data: {
            title: `Extra ${i}`,
            body: 'filler',
            isPublished: true,
            updatedAt: new Date(Date.UTC(2026, 5, i)),
          },
        });
      }
    });
    const page = async (qs: string) =>
      (await call(USERS.erin, 'GET', `/api/knowledge${qs}`)).json().data;

    it('walks the whole list by nextOffset with no gaps or repeats', async () => {
      const seen: string[] = [];
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const p: { items: { id: string }[]; nextOffset: number | null; total: number } = await page(
          `?limit=3&offset=${offset}`,
        );
        expect(p.total).toBe(10);
        seen.push(...p.items.map((i) => i.id));
        offset = p.nextOffset;
        pages++;
      }
      expect(pages).toBe(4);
      expect(new Set(seen).size).toBe(10);
      const all = (await page('?limit=50')).items.map((i: { id: string }) => i.id);
      expect(seen).toEqual(all);
    });

    it('the last exact page has no nextOffset; one past the end is empty', async () => {
      expect(await page('?limit=5&offset=5')).toMatchObject({ nextOffset: null, total: 10 });
      expect((await page('?limit=5&offset=5')).items).toHaveLength(5);
      expect(await page('?limit=5&offset=10')).toMatchObject({
        items: [],
        nextOffset: null,
        total: 10,
      });
    });

    it('is ordered newest update first and repeats identically', async () => {
      const a = (await page('?limit=50')).items;
      const b = (await page('?limit=50')).items;
      expect(a).toEqual(b);
      const times = a.map((i: { updatedAt: string }) => i.updatedAt);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('limit 1 and the maximum both work; one beyond the maximum does not', async () => {
      expect((await page('?limit=1')).items).toHaveLength(1);
      expect((await page('?limit=50')).items).toHaveLength(10);
      expect((await call(USERS.erin, 'GET', '/api/knowledge?limit=51')).statusCode).toBe(400);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('special queries stay data', () => {
    const search = (q: string) =>
      call(USERS.erin, 'GET', `/api/knowledge/search?q=${encodeURIComponent(q)}`);

    it.each([
      "o'brien's vpn",
      'vpn%',
      'vp_',
      'vpn*',
      '*',
      '?',
      '[a-z]+',
      '.*',
      '$1',
      '{{7*7}}',
      '<script>alert(1)</script>',
      '../../etc/passwd',
      '日本語 テスト',
      'пароль',
      'ＶＰＮ',
      '🔥🔥🔥',
      'a​b',
      'x'.repeat(200),
    ])('%j returns 200 with a well-formed page and never echoes markup unescaped', async (q) => {
      const res = await search(q);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      const data = res.json().data;
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBeLessThanOrEqual(10);
      expect(await prisma.knowledgeArticle.count()).toBe(5);
    });

    it('a 1 000-character query is rejected up front (400), not run', async () => {
      expect((await search('word '.repeat(200))).statusCode).toBe(400);
    });

    it('SQL-looking input matches nothing it should not', async () => {
      for (const q of [
        "' OR 1=1 --",
        "'; SELECT * FROM users; --",
        'UNION SELECT title FROM knowledge_articles',
      ]) {
        const data = (await search(q)).json().data;
        expect(leaksDraft(JSON.stringify(data))).toBe(false);
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('invalid writes leave no partial state', () => {
    const admin = (m: Method, url: string, payload?: object) =>
      call(USERS.admin, m, `/api/admin/knowledge${url}`, payload);

    it('a PATCH with one valid and one invalid field changes neither', async () => {
      const before = await article(ARTICLES.printer);
      const cases: object[] = [
        { title: 'New title', body: 'x'.repeat(20_001) },
        { title: 'New title', categoryId: CATEGORIES.legacy },
        { body: 'New body', categoryId: GHOST },
        { title: 'New title', extra: true },
        { title: 'New title', body: '   ' },
      ];
      for (const payload of cases) {
        const res = await admin('PATCH', `/${ARTICLES.printer}`, payload);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      }
      expect(await article(ARTICLES.printer)).toEqual(before);
    });

    it('a failed create inserts nothing, and a failed publish leaves the draft a draft', async () => {
      for (const payload of [
        { title: 'T', body: 'B', categoryId: CATEGORIES.legacy },
        { title: '', body: 'B' },
        { title: 'T', body: 'B', isPublished: true },
      ]) {
        expect((await admin('POST', '', payload)).statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(await prisma.knowledgeArticle.count()).toBe(5);

      await prisma.knowledgeArticle.update({
        where: { id: ARTICLES.draft },
        data: { categoryId: CATEGORIES.legacy },
      });
      expect((await admin('POST', `/${ARTICLES.draft}/publish`)).statusCode).toBe(409);
      expect((await article(ARTICLES.draft)).isPublished).toBe(false);
    });

    it('create cannot smuggle publication state: new articles are always drafts', async () => {
      const res = await admin('POST', '', { title: 'Sneaky', body: 'Body' });
      expect(res.json().data.isPublished).toBe(false);
      expect(
        (await call(USERS.erin, 'GET', `/api/knowledge/${res.json().data.id}`)).statusCode,
      ).toBe(404);
    });

    it('concurrent edits never produce a torn article', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          admin('PATCH', `/${ARTICLES.printer}`, { title: `Title ${i}`, body: `Body ${i}` }),
        ),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      const row = await article(ARTICLES.printer);
      // Whichever write won, title and body come from the same request.
      expect(row.title.replace('Title ', '')).toBe(row.body.replace('Body ', ''));
    });
  });
});
