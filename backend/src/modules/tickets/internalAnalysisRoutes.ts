import { analysisLeaseMs, classifyAnalysisFailure, type AiConfig } from '@smartdesk/ai-analysis';
import {
  analysisJobFailureV1Schema,
  analysisJobIdentityV1Schema,
  recordRecommendationCommandV1Schema,
  type AnalysisJobIdentityV1,
} from '@smartdesk/contracts';
import type { PrismaClient } from '@smartdesk/db';
import { hashCorrelationId } from '@smartdesk/service-runtime';
import type { FastifyContextConfig, FastifyPluginAsync, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  claimNext,
  completeJob,
  failAttempt,
  findByRequest,
  hasActiveAnalysisLease,
} from '../../db/repositories/aiAnalysisJobs.js';
import { findRecommendationByJob } from '../../db/repositories/aiRecommendations.js';
import { withTransaction } from '../../db/transaction.js';
import { HttpError } from '../../plugins/errors.js';
import { createAnalysisInputReader } from '../ai/analysisService.js';
import { persistRecommendation } from '../ai/recommendationService.js';
import type { SearchClient } from '../search/client.js';

const privateRoute: FastifyContextConfig & { cors: false } = { cors: false };
const leaseLost = () => new HttpError(409, 'Analysis lease unavailable');
const leaseOf = ({ jobId: id, ticketId, requestId, leaseToken }: AnalysisJobIdentityV1) => ({
  id,
  ticketId,
  requestId,
  leaseToken,
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Invalid analysis command');
  return parsed.data;
}

export const internalAnalysisRoutes =
  (
    prisma: PrismaClient,
    config: AiConfig,
    searchClient: SearchClient | undefined,
    remoteKnowledge: boolean,
    guard: Record<'claim' | 'inputs' | 'complete' | 'fail', onRequestAsyncHookHandler>,
  ): FastifyPluginAsync =>
  async (app) => {
    const readInputs = createAnalysisInputReader(
      prisma,
      searchClient,
      remoteKnowledge ? async () => undefined : undefined,
    );
    const route = (key: keyof typeof guard) => ({
      config: privateRoute,
      onRequest: guard[key],
      bodyLimit: 32 * 1024,
    });
    app.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });
    for (const path of ['/claim', '/inputs', '/complete', '/fail']) {
      app.options(path, { config: privateRoute }, (_req, reply) => reply.callNotFound());
    }

    app.post('/claim', route('claim'), async (req, reply) => {
      if (config.provider === 'none') return reply.code(204).send();
      const job = await claimNext(prisma, { leaseMs: analysisLeaseMs(config) });
      if (!job) return reply.code(204).send();
      req.log.info({
        event: 'analysis_claimed',
        correlationId: hashCorrelationId(req.id),
        originCorrelationId: job.correlationId ?? hashCorrelationId(job.requestId),
        analysisCorrelationId: hashCorrelationId(job.requestId),
        jobId: job.id,
        ticketId: job.ticketId,
        attempt: job.attempts,
      });
      return {
        schemaVersion: 1,
        jobId: job.id,
        ticketId: job.ticketId,
        requestId: job.requestId,
        leaseToken: job.leaseToken,
        attempts: job.attempts,
      };
    });

    app.post('/inputs', route('inputs'), async (req) => {
      const lease = leaseOf(parse(analysisJobIdentityV1Schema, req.body));
      if (!(await hasActiveAnalysisLease(prisma, lease))) throw leaseLost();
      const inputs = await readInputs(lease.ticketId);
      // Retrieval can outlast a lease. Only the current holder may receive the snapshot.
      if (!(await hasActiveAnalysisLease(prisma, lease))) throw leaseLost();
      return { schemaVersion: 1, ...inputs };
    });

    app.post('/complete', route('complete'), async (req, reply) => {
      const command = parse(recordRecommendationCommandV1Schema, req.body);
      const lease = leaseOf(command);
      const done = await withTransaction(prisma, async (tx) => {
        if (await completeJob(tx, lease)) {
          await persistRecommendation(tx, {
            job: lease,
            draft: command.draft,
            promptVersion: command.promptVersion,
          });
          return true;
        }
        // A lost response can be retried. Confirm the existing logical result without applying a
        // new draft, including when a later lease has already committed the winning recommendation.
        const job = await findByRequest(tx, lease.ticketId, lease.requestId);
        return (
          job?.id === lease.id &&
          job.state === 'COMPLETED' &&
          (await findRecommendationByJob(tx, job.id)) !== null
        );
      });
      if (!done) throw leaseLost();
      return reply.code(204).send();
    });

    app.post('/fail', route('fail'), async (req) => {
      const failure = parse(analysisJobFailureV1Schema, req.body);
      const state = await failAttempt(prisma, leaseOf(failure), {
        errorKind: failure.kind,
        retryable: classifyAnalysisFailure(failure.kind).retryable,
        backoffBaseMs: config.worker.backoffBaseMs,
      });
      if (!state) throw leaseLost();
      return { state };
    });
  };
