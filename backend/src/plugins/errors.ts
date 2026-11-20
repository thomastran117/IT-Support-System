import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiEnvelope } from '@smartdesk/contracts';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
  }
}

const NAMES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function envelope<T>(
  message: string,
  data: T | null = null,
  error: string | null = null,
  details: unknown = null,
): ApiEnvelope<T> {
  return { message, error, details, data };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(envelope(`Route ${req.method} ${req.url} not found`, null, NAMES[404]));
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    let status = 500;
    let details: unknown = null;
    let message = 'Internal server error';

    if (err instanceof HttpError) {
      status = err.statusCode;
      message = err.message;
      details = err.details;
    } else if ('validation' in err && err.validation) {
      status = 400;
      message = 'Validation failed';
      details = err.validation;
    } else if (
      'statusCode' in err &&
      err.statusCode &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      status = err.statusCode;
      message = status === 400 ? 'Malformed request' : err.message;
    }

    if (status >= 500) req.log.error({ err }, 'unhandled error');
    // Unexpected failures never expose their message or stack.
    if (status >= 500 && !(err instanceof HttpError)) message = 'Internal server error';
    reply.code(status).send(envelope(message, null, NAMES[status] ?? 'Error', details));
  });
}
