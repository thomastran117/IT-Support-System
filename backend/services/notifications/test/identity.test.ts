import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { NOTIFICATION_IDENTITY } from '@smartdesk/contracts';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { createRecipientResolver } from '../src/identity.js';

test('binds the delegated token and accepts only a minimal recipient response', async (t) => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const recipientId = '00000000-0000-4000-8000-000000000009';
  const userToken = 'synthetic-user-token';
  let requests = 0;
  let body: object = { recipientId };
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, NOTIFICATION_IDENTITY.path);
      assert.equal(req.headers['x-request-id'], 'test-request');
      assert.equal(req.headers['x-smartdesk-internal-user-token'], userToken);
      const { payload } = await jwtVerify(req.headers.authorization!.slice(7), publicKey, {
        issuer: 'smartdesk-internal',
        audience: NOTIFICATION_IDENTITY.audience,
        subject: 'notifications',
        typ: 'smartdesk-service+jwt',
      });
      assert.equal(payload.scope, NOTIFICATION_IDENTITY.scope);
      assert.deepEqual(payload.actor, {
        kind: 'user',
        tokenHash: createHash('sha256').update(userToken).digest('base64url'),
      });
      requests++;
      res.end(JSON.stringify(body));
    } catch {
      res.writeHead(400).end();
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const resolve = await createRecipientResolver({
    identityOrigin: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    keyId: 'notification-test',
    privateKey: await exportPKCS8(privateKey),
  });
  await assert.rejects(resolve(undefined, 'test-request'), { status: 401 });
  assert.equal(requests, 0);
  assert.equal(await resolve(`Bearer ${userToken}`, 'test-request'), recipientId);
  body = { recipientId, passwordHash: 'unexpected' };
  await assert.rejects(resolve(`Bearer ${userToken}`, 'test-request'), { status: 503 });
});
