import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWLEDGE_RETRIEVAL } from '@smartdesk/contracts';
import type { PrismaClient } from '@smartdesk/db';
import { ServiceRequestError } from '@smartdesk/service-runtime/delegated-identity';
import { buildKnowledgeApp } from '../src/app.js';

test('requires browser roles and scoped system authentication before accessing article rows', async () => {
  const app = await buildKnowledgeApp({
    prisma: {} as PrismaClient,
    resolvePrincipal: async (authorization) => {
      if (!authorization) throw new ServiceRequestError(401, 'Authentication required');
      return { id: 'user', role: 'EMPLOYEE' };
    },
    verifyRetrievalToken: async (token, scope, kind) => {
      assert.equal(scope, KNOWLEDGE_RETRIEVAL.scope);
      assert.equal(kind, 'system');
      return token === 'allowed'
        ? { result: 'authorized', service: 'ai', actor: { kind: 'system' } }
        : { result: 'forbidden' };
    },
    frontendOrigin: 'http://localhost:3000',
    logLevel: 'silent',
  });
  try {
    assert.equal((await app.inject('/api/knowledge')).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/knowledge',
          headers: { authorization: 'Bearer employee', 'x-actor-role': 'ADMIN' },
          payload: { title: 'Draft', body: 'Article body' },
        })
      ).statusCode,
      403,
    );
    const invoke = (token?: string, extra = {}) =>
      app.inject({
        method: 'POST',
        url: KNOWLEDGE_RETRIEVAL.path,
        headers: { ...(token && { authorization: `Bearer ${token}` }), ...extra },
        payload: { terms: Array.from({ length: 13 }, () => 'vpn') },
      });
    assert.equal((await invoke()).statusCode, 401);
    assert.equal((await invoke('wrong-scope')).statusCode, 403);
    assert.equal(
      (await invoke('allowed', { 'x-smartdesk-internal-user-token': 'user' })).statusCode,
      403,
    );
    assert.equal((await invoke('allowed')).statusCode, 400);
  } finally {
    await app.close();
  }
});
