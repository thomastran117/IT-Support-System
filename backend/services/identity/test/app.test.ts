import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@smartdesk/db';
import { loadSessionConfig, TokenService } from '@smartdesk/identity';
import { buildIdentityApp } from '../src/app.js';

test('checks live account state without loading team memberships or credential hashes', async () => {
  const session = loadSessionConfig({ FRONTEND_ORIGIN: 'http://ui.test' });
  const user = {
    id: '08bf7c83-2039-4d24-ac84-3a2694926c59',
    email: 'employee@smartdesk.test',
    displayName: 'Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 2,
  };
  const prisma = {
    user: {
      findUnique: async ({ select }: { select: Record<string, boolean> }) => {
        assert.deepEqual(Object.keys(select).sort(), [
          'displayName',
          'email',
          'id',
          'isActive',
          'role',
          'tokenVersion',
        ]);
        return user;
      },
    },
  } as unknown as PrismaClient;
  const app = await buildIdentityApp({
    prisma,
    session,
    internalServiceKeys: [],
    logLevel: 'silent',
  });
  const tokens = new TokenService(session);
  try {
    const headers = { authorization: `Bearer ${await tokens.sign('access', user.id, 2)}` };
    const current = await app.inject({ url: '/api/auth/me', headers });
    assert.equal(current.statusCode, 200);
    assert.deepEqual(Object.keys(current.json().data).sort(), [
      'displayName',
      'email',
      'id',
      'role',
    ]);
    assert.equal(current.headers['cache-control'], 'no-store');
    assert.equal((await app.inject({ url: '/api/admin/users', headers })).statusCode, 403);
    user.tokenVersion += 1;
    assert.equal((await app.inject({ url: '/api/auth/me', headers })).statusCode, 401);
    const refreshed = { authorization: `Bearer ${await tokens.sign('access', user.id, 3)}` };
    user.isActive = false;
    assert.equal((await app.inject({ url: '/api/auth/me', headers: refreshed })).statusCode, 401);
  } finally {
    await app.close();
  }
});
