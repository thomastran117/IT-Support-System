import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { test, type TestContext } from 'node:test';
import { buildGateway } from '../src/app.js';

const frontendOrigin = 'http://localhost:3000';

async function startUpstream(t: TestContext, listener: RequestListener) {
  const server = createServer(listener).listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  await once(server, 'listening');
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

async function startGateway(t: TestContext, upstream: URL, timeoutMs = 2000) {
  const gateway = buildGateway({ upstream, timeoutMs, frontendOrigin });
  t.after(() => gateway.close());
  return gateway.listen({ host: '127.0.0.1', port: 0 });
}

test('routes the inbox to its active owner and isolates its upstream timeout', async (t) => {
  const ticket = await startUpstream(t, (_req, res) => res.end('ticket'));
  let available = true;
  const notifications = await startUpstream(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer notification-test');
    assert.equal(req.headers['x-user-id'], undefined);
    if (available) res.end(req.url);
  });
  const app = buildGateway({
    upstream: ticket,
    notificationsUpstream: notifications,
    timeoutMs: 300,
    frontendOrigin,
  });
  t.after(() => app.close());
  const headers = { authorization: 'Bearer notification-test', 'x-user-id': 'forged' };
  for (const url of ['/api/notifications?unreadOnly=true', '/api/notifications/read-all']) {
    expectResponse(url, await app.inject({ url, headers }));
  }
  assert.equal((await app.inject('/api/notifications-other')).body, 'ticket');
  available = false;
  assert.equal((await app.inject({ url: '/api/notifications', headers })).statusCode, 503);
  assert.equal((await app.inject('/api/tickets')).body, 'ticket');

  function expectResponse(path: string, response: { statusCode: number; body: string }) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, path);
  }
});

test('preserves the method, original path, body, session headers and conflict response', async (t) => {
  const path = '/api/tickets/ticket-id/routing?tag=a%2Bb&tag=c';
  const body = '{ "expectedVersion": 2 }';
  const cookies = ['sd_refresh=rotated; HttpOnly; Path=/api/auth', 'extra=1; Path=/'];
  const conflict = {
    message: 'Ticket has changed',
    error: 'Conflict',
    details: { code: 'VERSION_CONFLICT', currentVersion: 3 },
    data: null,
  };
  const upstream = await startUpstream(t, async (req, res) => {
    assert.equal(req.url, path);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer local-test');
    assert.equal(req.headers.cookie, 'sd_refresh=previous');
    assert.equal(req.headers.origin, frontendOrigin);
    assert.equal(req.headers['idempotency-key'], 'ticket-request-key');
    assert.equal(req.headers['x-request-id'], 'test-request-id');
    assert.equal(req.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(req.headers['x-forwarded-host'], undefined);
    assert.equal(req.headers.forwarded, undefined);
    assert.equal(req.headers['x-connection-only'], undefined);
    assert.equal(req.headers['x-smartdesk-internal-user-token'], undefined);
    assert.equal(req.headers['x-actor-role'], undefined);
    assert.equal(req.headers['x-user-id'], undefined);
    assert.equal(req.headers['x-service-id'], undefined);
    assert.equal(await text(req), body);
    res.writeHead(409, {
      'content-type': 'application/json',
      'set-cookie': cookies,
      'retry-after': '3',
      'cache-control': 'no-store',
      'access-control-allow-origin': frontendOrigin,
      'access-control-allow-credentials': 'true',
      connection: 'close, x-upstream-connection-only',
      'x-upstream-connection-only': 'private hop',
    });
    res.end(JSON.stringify(conflict));
  });
  const gateway = await startGateway(t, upstream);
  const response = await new Promise<{
    status?: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = request(
      gateway + path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: frontendOrigin,
          authorization: 'Bearer local-test',
          cookie: 'sd_refresh=previous',
          'idempotency-key': 'ticket-request-key',
          'x-request-id': 'test-request-id',
          'x-forwarded-for': '198.51.100.4',
          'x-forwarded-host': 'unknown.test',
          forwarded: 'for=198.51.100.4',
          'x-smartdesk-internal-user-token': 'untrusted-user-credential',
          'x-actor-role': 'ADMIN',
          'x-user-id': 'untrusted-user-id',
          'x-service-id': 'untrusted-service-id',
          connection: 'close, x-connection-only',
          'x-connection-only': 'client hop',
        },
      },
      (res) =>
        text(res).then(
          (body) => resolve({ status: res.statusCode, headers: res.headers, body }),
          reject,
        ),
    );
    req.once('error', reject);
    req.end(body);
  });
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), conflict);
  assert.deepEqual(response.headers['set-cookie'], cookies);
  assert.equal(response.headers['access-control-allow-origin'], frontendOrigin);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.equal(response.headers['x-request-id'], 'test-request-id');
  assert.equal(response.headers['retry-after'], '3');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-upstream-connection-only'], undefined);
});

test('forwards health, HEAD and CORS preflights and keeps other paths local', async (t) => {
  const calls: string[] = [];
  const upstream = await startUpstream(t, (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const requestId = req.headers['x-request-id'];
    assert.match(String(requestId), /^[\da-f-]{36}$/);
    res.setHeader('x-request-id', requestId!);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        vary: 'Access-Control-Request-Headers',
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
        'access-control-allow-headers': req.headers['access-control-request-headers']!,
      });
      res.end();
    } else if (req.url === '/health/ready') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"status":"unavailable","checks":{"database":"unavailable","cache":"disabled"}}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '15' });
      res.end('{"status":"ok"}');
    }
  });
  const gateway = await startGateway(t, upstream);
  const live = await fetch(gateway + '/health/live', { method: 'HEAD' });
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('content-length'), '15');
  assert.equal(await live.text(), '');
  const ready = await fetch(gateway + '/health/ready');
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    status: 'unavailable',
    checks: { database: 'unavailable', cache: 'disabled' },
  });

  const preflight = await fetch(gateway + '/api/auth/refresh', {
    method: 'OPTIONS',
    headers: {
      origin: frontendOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization,content-type');
  assert.equal(preflight.headers.get('vary'), 'Access-Control-Request-Headers');
  assert.equal(
    (
      await fetch(gateway + '/internal/tickets/example/work-access', {
        headers: { authorization: 'Bearer local-test' },
      })
    ).status,
    404,
  );
  assert.deepEqual(calls, ['HEAD /health/live', 'GET /health/ready', 'OPTIONS /api/auth/refresh']);
});

test('enforces the same body limit before sending requests upstream', async (t) => {
  const upstream = await startUpstream(t, (_req, res) => {
    res.writeHead(418).end();
  });
  const gateway = await startGateway(t, upstream);
  const response = await fetch(gateway + '/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: frontendOrigin },
    body: JSON.stringify({ text: 'a'.repeat(1024 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('access-control-allow-origin'), frontendOrigin);
  assert.deepEqual(await response.json(), {
    message: 'Request body is too large',
    error: 'Error',
    details: null,
    data: null,
  });
});

test('times out a stalled upstream and sends a safe 503 without retrying the write', async (t) => {
  let calls = 0;
  const upstream = await startUpstream(t, () => {
    calls++;
  });
  const gateway = await startGateway(t, upstream, 250);
  const response = await fetch(gateway + '/api/tickets', {
    method: 'POST',
    headers: { 'x-request-id': 'timeout-request' },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-request-id'), 'timeout-request');
  assert.deepEqual(await response.json(), {
    message: 'API temporarily unavailable',
    error: 'Service Unavailable',
    details: null,
    data: null,
  });
  assert.equal(calls, 1);
});

test('maps an upstream connection reset before headers to a safe 502', async (t) => {
  const upstream = await startUpstream(t, (req) => req.socket.destroy());
  const gateway = await startGateway(t, upstream);
  const response = await fetch(gateway + '/health/ready', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    message: 'Invalid upstream response',
    error: 'Bad Gateway',
    details: null,
    data: null,
  });
});

test('closes an interrupted response when the upstream stalls after sending a body chunk', async (t) => {
  const upstream = await startUpstream(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.write('{"data":');
  });
  const gateway = await startGateway(t, upstream, 500);
  const response = await fetch(gateway + '/api/ping', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), TypeError);
});
