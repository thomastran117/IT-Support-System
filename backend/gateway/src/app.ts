import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';

const hopByHop = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const untrustedPrefixes = [
  'x-forwarded-',
  'x-smartdesk-internal-',
  'x-internal-',
  'x-actor-',
  'x-user-',
  'x-service-',
];

function endToEndHeaders(headers: IncomingMessage['headers']) {
  const connectionHeaders = (headers.connection ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !hopByHop.includes(name) && !connectionHeaders.includes(name),
    ),
  );
}

function forward(req: FastifyRequest, origin: URL, signal: AbortSignal) {
  const headers = endToEndHeaders(req.headers);
  for (const name of Object.keys(headers)) {
    if (name === 'forwarded' || untrustedPrefixes.some((prefix) => name.startsWith(prefix))) {
      delete headers[name];
    }
  }
  delete headers.host;
  delete headers.expect;
  delete headers['content-length'];
  const body = Buffer.isBuffer(req.body) ? req.body : undefined;
  if (body) headers['content-length'] = String(body.length);
  headers['x-forwarded-for'] = req.ip;
  headers['x-request-id'] = req.id;

  const request = origin.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const upstream = request(
      origin,
      { method: req.method, path: req.url, headers, signal },
      resolve,
    );
    upstream.on('error', reject);
    upstream.end(body);
  });
}

const errorNames: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};
const unavailableCodes = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export interface GatewayOptions {
  upstream: URL;
  notificationsUpstream?: URL;
  analyticsUpstream?: URL;
  knowledgeUpstream?: URL;
  timeoutMs: number;
  frontendOrigin: string;
  trustProxy?: boolean | string[];
  logLevel?: string;
}

export function buildGateway(opts: GatewayOptions) {
  const app = Fastify({
    logger: opts.logLevel ? { level: opts.logLevel } : false,
    trustProxy: opts.trustProxy ?? false,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  // The backend owns CORS on proxied responses. Match its fixed origin and credential headers
  // on gateway-generated errors so callers from the configured frontend can read the envelope.
  const sendError = (reply: FastifyReply, status: number, message: string) =>
    reply
      .headers({
        'access-control-allow-origin': opts.frontendOrigin,
        'access-control-allow-credentials': 'true',
      })
      .code(status)
      .send({ message, error: errorNames[status] ?? 'Error', details: null, data: null });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.setNotFoundHandler((req, reply) =>
    sendError(reply, 404, `Route ${req.method} ${req.url} not found`),
  );
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    const code = error.statusCode ?? 500;
    const status = code >= 400 && code < 500 ? code : 500;
    if (status === 500) req.log.error('Gateway request failed');
    const message =
      status === 400
        ? 'Malformed request'
        : status === 500
          ? 'Internal server error'
          : error.message;
    sendError(reply, status, message);
  });

  // Fastify applies its normal 1 MiB body limit while collecting the original bytes.
  // The upstream still parses JSON and determines media type and schema errors.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    ['application/json', 'text/plain'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  async function proxy(req: FastifyRequest, reply: FastifyReply, upstream = opts.upstream) {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const disconnect = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) disconnect.abort();
    });
    const signal = AbortSignal.any([timeout, disconnect.signal]);
    let response: IncomingMessage;
    try {
      response = await forward(req, upstream, signal);
    } catch (error) {
      if (disconnect.signal.aborted) return;
      const code = (error as NodeJS.ErrnoException).code;
      const unavailable = timeout.aborted || unavailableCodes.has(code ?? '');
      const status = unavailable ? 503 : 502;
      const message = unavailable ? 'API temporarily unavailable' : 'Invalid upstream response';
      req.log.warn({ status, code }, message);
      return sendError(reply, status, message);
    }

    reply.code(response.statusCode ?? 502).headers(endToEndHeaders(response.headers));
    return reply.send(response);
  }

  for (const path of ['/api', '/api/*', '/health/live', '/health/ready']) app.all(path, proxy);
  for (const { prefix, upstream } of [
    { prefix: '/api/notifications', upstream: opts.notificationsUpstream },
    { prefix: '/api/admin/reports', upstream: opts.analyticsUpstream },
    { prefix: '/api/knowledge', upstream: opts.knowledgeUpstream },
    { prefix: '/api/admin/knowledge', upstream: opts.knowledgeUpstream },
  ]) {
    if (!upstream) continue;
    app.all(prefix, (req, reply) => proxy(req, reply, upstream));
    app.all(`${prefix}/*`, (req, reply) => proxy(req, reply, upstream));
  }
  return app;
}
