import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@smartdesk/db';
import { ServiceRequestError } from '@smartdesk/service-runtime/delegated-identity';
import { buildAnalyticsApp } from '../src/app.js';

test('authenticates reports before validating the window or querying PostgreSQL', async () => {
  const app = await buildAnalyticsApp({
    prisma: {} as PrismaClient,
    resolvePrincipal: async (authorization) => {
      if (!authorization) throw new ServiceRequestError(401, 'Authentication required');
      return {
        id: 'f10d284f-a851-433a-a0b9-6e0b7c5e68cd',
        role: authorization === 'Bearer admin' ? 'ADMIN' : 'TECHNICIAN',
      };
    },
    frontendOrigin: 'http://localhost:3000',
    logLevel: 'silent',
  });
  try {
    for (const report of ['summary', 'ai-evaluation']) {
      const url = '/api/admin/reports/' + report;
      assert.equal((await app.inject(url)).statusCode, 401);
      const denied = await app.inject({
        url,
        headers: { authorization: 'Bearer technician', 'x-actor-role': 'ADMIN' },
      });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.headers['cache-control'], 'no-store');
      const invalid = await app.inject({ url, headers: { authorization: 'Bearer admin' } });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().message, 'Validation failed');
    }
  } finally {
    await app.close();
  }
});
