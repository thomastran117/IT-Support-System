import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { searchPublished } from '../../src/db/repositories/knowledge.js';
import { ARTICLES, CATEGORIES, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const env = loadEnv({ FRONTEND_ORIGIN: 'http://app.test' });
const tokens = new TokenService(env);

interface Hit {
  id: string;
  title: string;
  preview: string;
  rank: number;
  category: { id: string; name: string } | null;
}

describe.skipIf(!testDatabaseUrl)('knowledge full-text search (integration)', () => {
  const prisma = createTestPrisma();
  let app: FastifyInstance;

  const bearer = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { authorization: `Bearer ${await tokens.sign('access', userId, u.tokenVersion)}` };
  };
  const search = async (qs: string, as: string | null = USERS.erin) =>
    app.inject({
      method: 'GET',
      url: `/api/knowledge/search${qs}`,
      headers: as ? await bearer(as) : {},
    });
  const q = (term: string, extra = '') => `?q=${encodeURIComponent(term)}${extra}`;
  const ids = async (term: string, extra = '') => {
    const res = await search(q(term, extra));
    expect(res.statusCode).toBe(200);
    return (res.json().data.items as Hit[]).map((h) => h.id);
  };

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

  it('requires authentication', async () => {
    expect((await search(q('vpn'), null)).statusCode).toBe(401);
  });

  describe('representative terms', () => {
    it.each([
      ['vpn', ARTICLES.vpn],
      ['VPN disconnects', ARTICLES.vpn],
      ['printer', ARTICLES.printer],
      ['paper jam', ARTICLES.printer],
      ['print spooler', ARTICLES.printer],
      ['forgotten password', ARTICLES.password],
      ['locked account', ARTICLES.password],
      ['multi-factor', ARTICLES.password],
      ['licence renewal', ARTICLES.software],
    ])('"%s" finds the expected article first', async (term, expected) => {
      expect((await ids(term))[0]).toBe(expected);
    });

    it('stems and ignores case: "Printers JAMMED" still finds the printer article', async () => {
      expect(await ids('Printers JAMMED')).toContain(ARTICLES.printer);
    });

    it('returns a compact, plain-text preview and the source id', async () => {
      const [hit] = (await search(q('vpn'))).json().data.items as Hit[];
      expect(hit).toMatchObject({
        id: ARTICLES.vpn,
        title: 'Fix a VPN that disconnects repeatedly',
        category: { id: CATEGORIES.network },
      });
      expect(hit!.preview.length).toBeLessThanOrEqual(201);
      expect(hit!.preview).toMatch(/^If the VPN client drops every hour/);
      expect(typeof hit!.rank).toBe('number');
      expect(hit).not.toHaveProperty('body');
    });

    it('truncates long bodies with an ellipsis and collapses whitespace', async () => {
      const long = await prisma.knowledgeArticle.create({
        data: {
          title: 'Zebra stripes',
          body: `zebra   \n\n  ${'word '.repeat(100)}`,
          isPublished: true,
        },
      });
      const [hit] = (await search(q('zebra'))).json().data.items as Hit[];
      expect(hit!.id).toBe(long.id);
      expect(hit!.preview.endsWith('…')).toBe(true);
      expect(hit!.preview).not.toMatch(/\s{2}/);
      expect(hit!.preview.length).toBeLessThanOrEqual(201);
    });
  });

  describe('visibility', () => {
    it('never returns drafts, even for a query that matches only the draft', async () => {
      expect(await ids('laptop onboarding checklist')).toEqual([]);
      expect(await ids('provisioning')).toEqual([]);
      // Admins use the same published-only search.
      const res = await search(q('onboarding'), USERS.admin);
      expect(res.json().data.items).toEqual([]);
    });

    it('drops an article from search when unpublished and restores it when republished', async () => {
      await prisma.knowledgeArticle.update({
        where: { id: ARTICLES.vpn },
        data: { isPublished: false },
      });
      expect(await ids('vpn')).toEqual([]);
      await prisma.knowledgeArticle.update({
        where: { id: ARTICLES.vpn },
        data: { isPublished: true },
      });
      expect(await ids('vpn')).toEqual([ARTICLES.vpn]);
    });

    it('the shared repository function also excludes drafts', async () => {
      const { hits, total } = await searchPublished(prisma, {
        query: 'laptop onboarding',
        limit: 10,
        offset: 0,
      });
      expect(hits).toEqual([]);
      expect(total).toBe(0);
    });

    it('a draft category filter value does not widen the candidate set', async () => {
      expect(await ids('laptop', `&categoryId=${CATEGORIES.hardware}`)).toEqual([]);
    });
  });

  describe('ranking and ordering', () => {
    it('ranks a title hit above a body-only hit', async () => {
      const bodyOnly = await prisma.knowledgeArticle.create({
        data: {
          title: 'General tips',
          body: 'Mention the kerberos ticket when you call the service desk.',
          isPublished: true,
        },
      });
      const titleHit = await prisma.knowledgeArticle.create({
        data: { title: 'Kerberos', body: 'Renew credentials from the portal.', isPublished: true },
      });
      const found = await ids('kerberos');
      expect(found).toEqual([titleHit.id, bodyOnly.id]);
    });

    it('breaks ties by newest update then id, identically on every call', async () => {
      const mk = (title: string, updatedAt: string, id: string) =>
        prisma.knowledgeArticle.create({
          data: { id, title, body: 'identical text about quokkas', isPublished: true, updatedAt },
        });
      await mk('Same', '2026-03-01T00:00:00Z', 'aaaaaaaa-0000-4000-8000-000000000002');
      await mk('Same', '2026-03-01T00:00:00Z', 'aaaaaaaa-0000-4000-8000-000000000001');
      await mk('Same', '2026-04-01T00:00:00Z', 'aaaaaaaa-0000-4000-8000-000000000003');
      const expected = [
        'aaaaaaaa-0000-4000-8000-000000000003', // newest first
        'aaaaaaaa-0000-4000-8000-000000000001', // then id ascending
        'aaaaaaaa-0000-4000-8000-000000000002',
      ];
      for (let i = 0; i < 3; i++) expect(await ids('quokkas')).toEqual(expected);
    });

    it('pages are consistent with the unpaged order', async () => {
      for (let i = 1; i <= 5; i++) {
        await prisma.knowledgeArticle.create({
          data: { title: `Router guide ${i}`, body: 'Reset the router.', isPublished: true },
        });
      }
      const all = await ids('router', '&limit=20');
      expect(all).toHaveLength(5);
      const p1 = await ids('router', '&limit=2&offset=0');
      const p2 = await ids('router', '&limit=2&offset=2');
      const p3 = await ids('router', '&limit=2&offset=4');
      expect([...p1, ...p2, ...p3]).toEqual(all);
    });
  });

  describe('filters and bounds', () => {
    beforeEach(async () => {
      await prisma.knowledgeArticle.create({
        data: {
          title: 'Network drive mapping',
          body: 'Map the shared network drive again after a password change.',
          categoryId: CATEGORIES.network,
          isPublished: true,
        },
      });
      await prisma.knowledgeArticle.create({
        data: {
          title: 'Wi-Fi connectivity problems',
          body: 'Rejoin the network, then call the network team.',
          categoryId: CATEGORIES.network,
          isPublished: true,
        },
      });
    });

    it('finds connectivity articles', async () => {
      expect((await ids('network connectivity'))[0]).toBeDefined();
      expect(await ids('rejoin wi-fi')).toHaveLength(1);
      expect((await ids('wifi network'))[0]).not.toBe(ARTICLES.printer);
    });

    it('filters by category', async () => {
      const network = await ids('network', `&categoryId=${CATEGORIES.network}`);
      expect(network.length).toBeGreaterThan(0);
      const rows = await prisma.knowledgeArticle.findMany({ where: { id: { in: network } } });
      expect(rows.every((r) => r.categoryId === CATEGORIES.network)).toBe(true);
      expect(await ids('network', `&categoryId=${CATEGORIES.software}`)).toEqual([]);
    });

    it('an unknown category yields an empty page, not an error', async () => {
      expect(await ids('vpn', '&categoryId=00000000-0000-4000-8000-000000000000')).toEqual([]);
    });

    it('caps the page size and reports the full total', async () => {
      const page = (await search(q('network', '&limit=1'))).json().data;
      expect(page.items).toHaveLength(1);
      expect(page.total).toBeGreaterThan(1);
      expect(page.nextOffset).toBe(1);
      const past = (await search(q('network', '&offset=500'))).json().data;
      expect(past.items).toEqual([]);
      expect(past.total).toBe(page.total);
      expect(past.nextOffset).toBeNull();
    });

    it.each(['&limit=0', '&limit=21', '&offset=-1', '&offset=1001', '&categoryId=x', '&limit=abc'])(
      'rejects bad parameter %s',
      async (extra) => {
        expect((await search(q('vpn', extra))).statusCode).toBe(400);
      },
    );

    it('rejects an over-long query (201 chars) and accepts 200', async () => {
      expect((await search(q('a'.repeat(201)))).statusCode).toBe(400);
      expect((await search(q('a'.repeat(200)))).statusCode).toBe(200);
    });
  });

  describe('empty and hostile input', () => {
    it.each(['', '   ', '?q=', '?q=%20%09'])('blank query %j returns an empty page', async (qs) => {
      const res = await search(qs.startsWith('?') ? qs : q(qs));
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ items: [], total: 0, nextOffset: null });
    });

    it('a request with no q at all is an empty page', async () => {
      expect((await search('')).json().data.items).toEqual([]);
    });

    it('no match is an empty page', async () => {
      expect((await search(q('xyzzyplugh'))).json().data).toMatchObject({ items: [], total: 0 });
    });

    it.each([
      "'; DROP TABLE knowledge_articles; --",
      "' OR '1'='1",
      '" OR 1=1 --',
      'vpn & | ! ( ) :* <->',
      '\\',
      '%_*?',
      '((((',
      '"unterminated quote',
      '-',
      '!!!',
      'vpn:*',
      '\u0000',
    ])('treats %j as data: no error, no damage', async (term) => {
      const res = await search(q(term));
      expect(res.statusCode).toBe(200);
      expect(await prisma.knowledgeArticle.count()).toBe(5);
    });

    it('still finds real terms inside noisy input', async () => {
      expect(await ids('"vpn" or (printer) !!!')).toEqual(
        expect.arrayContaining([ARTICLES.vpn, ARTICLES.printer]),
      );
      expect(await ids("vpn'")).toContain(ARTICLES.vpn);
    });

    it('does not treat wildcard characters as patterns', async () => {
      expect(await ids('%')).toEqual([]);
      expect(await ids('v_n')).toEqual([]);
    });

    it('handles Unicode', async () => {
      await prisma.knowledgeArticle.create({
        data: { title: 'Café Wi‑Fi pour 日本語', body: 'Naïve résumé 🚀', isPublished: true },
      });
      for (const term of ['café', 'résumé', '🚀', '日本語', 'ＶＰＮ']) {
        expect((await search(q(term))).statusCode).toBe(200);
      }
      expect((await ids('cafe')).length + (await ids('café')).length).toBeGreaterThan(0);
    });
  });

  describe('indexing', () => {
    it('uses the partial GIN index for a published-only search', async () => {
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN SELECT article_id FROM knowledge_articles
           WHERE is_published
             AND to_tsvector('english'::regconfig, title || ' ' || body)
                 @@ websearch_to_tsquery('english'::regconfig, 'vpn')`,
        );
      });
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('idx_knowledge_articles_fts');
    });
  });
});
