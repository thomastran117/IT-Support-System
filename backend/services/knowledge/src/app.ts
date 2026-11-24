import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import {
  API_PREFIX,
  KNOWLEDGE_RETRIEVAL,
  knowledgeRetrievalQuerySchema,
  type Role,
} from '@smartdesk/contracts';
import { runTransaction, type PrismaClient } from '@smartdesk/db';
import { HttpError, mapDbError } from '@smartdesk/db/errors';
import {
  adminKnowledgeRoutes,
  createKnowledgeService,
  createPublishedRetrieval,
  knowledgeRoutes,
} from '@smartdesk/knowledge';
import { ServiceRequestError } from '@smartdesk/service-runtime/delegated-identity';
import type { VerifyServiceToken } from '@smartdesk/service-runtime/service-tokens';
import Fastify, { type FastifyContextConfig, type preHandlerAsyncHookHandler } from 'fastify';

const privateRoute: FastifyContextConfig & { cors: false } = { cors: false };
const statusNames: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};
const errorBody = (status: number, message: string, details: unknown = null) => ({
  message,
  data: null,
  error: statusNames[status] ?? 'Error',
  details,
});

export async function buildKnowledgeApp(options: {
  prisma: PrismaClient;
  resolvePrincipal: (
    authorization: string | undefined,
    requestId: string,
  ) => Promise<{ id: string; role: Role }>;
  verifyRetrievalToken: VerifyServiceToken;
  frontendOrigin: string;
  logLevel: string;
}) {
  const { prisma, resolvePrincipal, verifyRetrievalToken } = options;
  const app = Fastify({
    logger: {
      level: options.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.body'],
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });
  await app.register(cors, {
    origin: options.frontendOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH'],
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ServiceRequestError) {
      return reply.code(error.status).send(errorBody(error.status, error.message, error.details));
    }
    const transportStatus =
      typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 0;
    if (!(error instanceof HttpError) && transportStatus >= 400 && transportStatus < 500) {
      const text = transportStatus === 400 ? 'Malformed request' : (error as Error).message;
      return reply.code(transportStatus).send(errorBody(transportStatus, text));
    }
    const safe = error instanceof HttpError ? error : mapDbError(error);
    const status = safe.statusCode;
    if (status >= 500) req.log.warn({ status }, 'Knowledge request failed');
    let details = safe.details;
    if ('code' in safe && typeof safe.code === 'string' && safe.code !== 'UNKNOWN') {
      details = { code: safe.code, ...(details && typeof details === 'object' ? details : {}) };
    }
    return reply.code(status).send(errorBody(status, safe.message, details));
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(errorBody(404, `Route ${req.method} ${req.url} not found`)),
  );
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT article_id FROM public.knowledge_articles LIMIT 0`;
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  const requireRole =
    (...roles: Role[]): preHandlerAsyncHookHandler =>
    async (req) => {
      const principal = await resolvePrincipal(req.headers.authorization, req.id);
      if (!roles.includes(principal.role)) {
        throw new HttpError(403, 'You do not have permission to perform this action');
      }
    };
  const service = createKnowledgeService(prisma);
  await app.register(knowledgeRoutes(service, requireRole), { prefix: `${API_PREFIX}/knowledge` });
  await app.register(adminKnowledgeRoutes(service, requireRole), {
    prefix: `${API_PREFIX}/admin/knowledge`,
  });

  const { path, scope } = KNOWLEDGE_RETRIEVAL;
  app.options(path, { config: privateRoute }, (_req, reply) => reply.callNotFound());
  app.post(
    path,
    {
      config: privateRoute,
      bodyLimit: 4096,
      onRequest: async (req) => {
        const token =
          req.headers.authorization && /^Bearer (\S+)$/i.exec(req.headers.authorization)?.[1];
        if (!token) throw new HttpError(401, 'Service authentication required');
        const result = await verifyRetrievalToken(token, scope, 'system');
        if (result.result === 'unauthenticated')
          throw new HttpError(401, 'Service authentication required');
        if (
          result.result !== 'authorized' ||
          req.headers['x-smartdesk-internal-user-token'] !== undefined
        ) {
          throw new HttpError(403, 'Service scope not allowed');
        }
      },
    },
    async (req) => {
      const parsed = knowledgeRetrievalQuerySchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid retrieval query');
      return runTransaction(
        prisma,
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
          return createPublishedRetrieval(tx)(parsed.data.terms);
        },
        { maxWaitMs: 250, timeoutMs: 1200, retries: 0, isolationLevel: 'ReadCommitted' },
      );
    },
  );
  return app;
}
