import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { buildAiService } from '../src/app.js';
import { loadServiceConfig } from '../src/config.js';

async function startTicketApi(t: TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

test('validates the Ticket origin, port, timeout and log level at startup', () => {
  const config = loadServiceConfig({ AI_SERVICE_TICKET_ORIGIN: 'http://gateway:4000' });
  assert.equal(config.ticketOrigin.origin, 'http://gateway:4000');
  assert.equal(config.readyTimeoutMs, 1500);
  assert.equal(config.port, 4010);
  for (const origin of [
    'gateway:4000',
    'http://',
    'postgres://gateway',
    'http://user:test-secret@gateway',
    'http://gateway/health/ready',
    'http://gateway?token=test-secret',
    'http://gateway#test-secret',
  ]) {
    assert.throws(() => loadServiceConfig({ AI_SERVICE_TICKET_ORIGIN: origin }), {
      message: 'AI_SERVICE_TICKET_ORIGIN must be an HTTP(S) origin without credentials',
    });
  }
  assert.throws(() => loadServiceConfig({ PORT: '65536' }), /PORT/);
  assert.throws(() => loadServiceConfig({ AI_SERVICE_READY_TIMEOUT_MS: '0' }), /READY_TIMEOUT/);
  assert.throws(() => loadServiceConfig({ AI_SERVICE_READY_TIMEOUT_MS: '5001' }), /READY_TIMEOUT/);
  assert.throws(() => loadServiceConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
});

test('reports Ticket readiness without using the dependency for liveness', async (t) => {
  let calls = 0;
  let healthy = true;
  const ticketOrigin = await startTicketApi(t, (req, res) => {
    calls++;
    assert.equal(req.url, '/health/ready');
    assert.equal(req.headers.authorization, undefined);
    const status = healthy ? 'ok' : 'unavailable';
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status, checks: { database: status, cache: 'disabled' } }));
  });
  const app = buildAiService({ ...loadServiceConfig({ LOG_LEVEL: 'silent' }), ticketOrigin });
  t.after(() => app.close());

  assert.deepEqual((await app.inject('/health/live')).json(), { status: 'ok' });
  assert.equal(calls, 0);
  const ready = await app.inject('/health/ready');
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.headers['cache-control'], 'no-store');
  assert.deepEqual(ready.json(), { status: 'ok', checks: { ticketApi: 'ok' } });

  healthy = false;
  const unavailable = await app.inject('/health/ready');
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), {
    status: 'unavailable',
    checks: { ticketApi: 'unavailable' },
  });
  assert.equal((await app.inject('/health/live')).statusCode, 200);
  assert.equal(calls, 2);
});

test('treats redirects, unexpected responses and a stalled body as unavailable', async (t) => {
  const ticketOrigin = await startTicketApi(t, (req, res) => {
    assert.equal(req.url, '/health/ready');
    res.writeHead(302, { location: '/moved' }).end();
  });
  const malformedOrigin = await startTicketApi(t, (_req, res) => {
    res.end('{"status":"ok"}');
  });
  const stalledOrigin = await startTicketApi(t, (_req, res) => {
    res.write('{"status":');
  });

  for (const origin of [ticketOrigin, malformedOrigin, stalledOrigin]) {
    const app = buildAiService({
      ...loadServiceConfig({ LOG_LEVEL: 'silent' }),
      ticketOrigin: origin,
      readyTimeoutMs: 200,
    });
    try {
      const ready = await app.inject('/health/ready');
      assert.equal(ready.statusCode, 503);
      assert.deepEqual(ready.json(), {
        status: 'unavailable',
        checks: { ticketApi: 'unavailable' },
      });
    } finally {
      await app.close();
    }
  }
});
