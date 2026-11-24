import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const hashCorrelationId = (requestId: string): string =>
  createHash('sha256').update(requestId).digest('hex');

export const requestIdOptions = {
  requestIdHeader: false as const,
  genReqId(req: IncomingMessage) {
    const supplied = req.headers['x-request-id'];
    return typeof supplied === 'string' && supplied.length > 0 ? supplied : randomUUID();
  },
};

export function serviceLogger(service: string, level?: string) {
  return {
    base: { service },
    ...(level ? { level } : {}),
    redact: {
      // Request metadata and errors are emitted as allowlisted fields by the observers.
      paths: ['reqId', 'req', 'res', 'err', 'error', 'headers', 'body'],
      remove: true,
    },
  };
}

export async function logHttpResponse(
  req: {
    id: string;
    method: string;
    routeOptions: { url: string | undefined };
    log: Pick<Console, 'info' | 'warn'>;
  },
  reply: { statusCode: number; elapsedTime: number },
) {
  const status = reply.statusCode;
  req.log[status >= 500 ? 'warn' : 'info']({
    event: 'http_request',
    correlationId: hashCorrelationId(req.id),
    method: req.method,
    route: req.routeOptions.url ?? 'unmatched',
    status,
    outcome: status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success',
    durationMs: reply.elapsedTime,
  });
}
