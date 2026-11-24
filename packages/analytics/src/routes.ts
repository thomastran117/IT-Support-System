import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import {
  REPORT_MAX_WINDOW_DAYS,
  type AiEvaluationReportDto,
  type ReportSummaryDto,
} from '@smartdesk/contracts';
import { z } from 'zod';
import type { createReportQueries, ReportWindow } from './reports.js';

const envelope = <T>(message: string, data: T) => ({ message, data, error: null, details: null });
export type ReportRead = <T>(key: string, fetch: () => Promise<T>) => Promise<T>;
const DAY_MS = 86_400_000;

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** ISO-8601 instant. Bare dates are UTC midnight; a missing offset or an impossible date is rejected. */
function toInstant(value: string): Date | null {
  const m = INSTANT.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    return null;
  }
  const date = new Date(m[4] ? value : `${value}T00:00:00Z`);
  return isNaN(date.getTime()) ? null : date;
}

const Instant = z
  .string()
  .max(40)
  .transform((v, ctx) => {
    const date = toInstant(v);
    if (!date) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use an ISO-8601 date or a date-time with an offset',
      });
      return z.NEVER;
    }
    return date;
  });

const SummaryQuery = z
  .strictObject({ start: Instant, end: Instant })
  .refine((q) => q.start.getTime() < q.end.getTime(), {
    message: 'start must be before end',
    path: ['start'],
  })
  .refine((q) => q.end.getTime() - q.start.getTime() <= REPORT_MAX_WINDOW_DAYS * DAY_MS, {
    message: `The window may not exceed ${REPORT_MAX_WINDOW_DAYS} days`,
    path: ['end'],
  });

/** Every UTC date touched by `[start, end)`, so empty days appear as zero. */
function dateBuckets(start: Date, end: Date): string[] {
  const out: string[] = [];
  const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  for (let t = first; t < end.getTime(); t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Both runtimes authorize each request, including legacy cache hits. */
export const createReportRoutes =
  (options: {
    prisma: PrismaClient;
    queries: ReturnType<typeof createReportQueries>;
    resolveAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<string>;
    badRequest: (details: unknown) => Error;
    read?: ReportRead;
  }): FastifyPluginAsync =>
  async (app) => {
    const { prisma, queries, resolveAdmin, badRequest, read } = options;
    const {
      reportAiAcceptance,
      reportAiAcceptanceByModel,
      reportAiAccuracy,
      reportAiAccuracyByModel,
      reportAiConfusion,
      reportDailyIntake,
      reportFirstResponse,
      reportRecurringCategories,
      reportResolutionTime,
      reportRoutingTime,
    } = queries;

    function parseQuery(input: unknown) {
      const result = SummaryQuery.safeParse(input);
      if (!result.success) throw badRequest(z.flattenError(result.error).fieldErrors);
      return result.data;
    }

    const cached = <T>(name: string, w: ReportWindow, fetch: () => Promise<T>): Promise<T> =>
      read ? read(`${name}:${w.start.toISOString()}_${w.end.toISOString()}`, fetch) : fetch();

    app.get('/summary', async (req, reply) => {
      const actor = await resolveAdmin(req, reply);
      const { start, end } = parseQuery(req.query);
      const w = { start, end };
      const [routing, firstResponse, resolution, accuracy, acceptance, categories, intake] =
        await Promise.all([
          cached('routingTime', w, () => reportRoutingTime(prisma, actor, w)),
          cached('firstResponse', w, () => reportFirstResponse(prisma, actor, w)),
          cached('resolutionTime', w, () => reportResolutionTime(prisma, actor, w)),
          cached('aiAccuracy', w, () => reportAiAccuracy(prisma, actor, w)),
          cached('aiAcceptance', w, () => reportAiAcceptance(prisma, actor, w)),
          cached('recurringCategories', w, () => reportRecurringCategories(prisma, actor, w)),
          cached('dailyIntake', w, () => reportDailyIntake(prisma, actor, w)),
        ]);
      const byDay = new Map(intake.map((d) => [d.reportDate, d.submittedTickets]));
      const body: ReportSummaryDto = {
        window: { start: start.toISOString(), end: end.toISOString() },
        submitted: routing.submitted,
        routing: { routed: routing.routed, avgMinutes: routing.avgMinutes },
        firstResponse: { responded: firstResponse.responded, avgMinutes: firstResponse.avgMinutes },
        resolution,
        aiAccuracy: accuracy,
        aiAcceptance: acceptance,
        categories,
        dailyIntake: dateBuckets(start, end).map((date) => ({
          date,
          submittedTickets: byDay.get(date) ?? 0,
        })),
        units: {
          routing: 'minutes',
          firstResponse: 'minutes',
          resolution: 'hours',
          rates: 'percent',
        },
      };
      reply.header('cache-control', 'no-store');
      return envelope('Report summary', body);
    });

    app.get('/ai-evaluation', async (req, reply) => {
      const actor = await resolveAdmin(req, reply);
      const { start, end } = parseQuery(req.query);
      const w = { start, end };
      const [accuracy, acceptance, accByModel, accepByModel, confusion] = await Promise.all([
        cached('aiAccuracy', w, () => reportAiAccuracy(prisma, actor, w)),
        cached('aiAcceptance', w, () => reportAiAcceptance(prisma, actor, w)),
        cached('aiAccuracyByModel', w, () => reportAiAccuracyByModel(prisma, actor, w)),
        cached('aiAcceptanceByModel', w, () => reportAiAcceptanceByModel(prisma, actor, w)),
        cached('aiConfusion', w, () => reportAiConfusion(prisma, actor, w)),
      ]);
      // A model appears if it has labelled tickets or reviews in the window.
      const versions = [
        ...new Set([
          ...accByModel.map((m) => m.modelVersion),
          ...accepByModel.map((m) => m.modelVersion),
        ]),
      ].sort();
      const body: AiEvaluationReportDto = {
        window: { start: start.toISOString(), end: end.toISOString() },
        overall: {
          labelledTickets: accuracy.labelledTickets,
          withRecommendation: accuracy.withRecommendation,
          withoutRecommendation: accuracy.labelledTickets - accuracy.withRecommendation,
          correct: accuracy.correct,
          accuracyPct: accuracy.accuracyPct,
        },
        acceptance,
        byModel: versions.map((modelVersion) => {
          const a = accByModel.find((m) => m.modelVersion === modelVersion);
          const r = accepByModel.find((m) => m.modelVersion === modelVersion);
          return {
            modelVersion,
            labelledTickets: a?.labelledTickets ?? 0,
            correct: a?.correct ?? 0,
            accuracyPct: a?.accuracyPct ?? null,
            reviewed: r?.reviewed ?? 0,
            accepted: r?.accepted ?? 0,
            acceptancePct: r?.acceptancePct ?? null,
          };
        }),
        confusion,
      };
      reply.header('cache-control', 'no-store');
      return envelope('AI evaluation report', body);
    });
  };
