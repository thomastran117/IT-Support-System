import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import {
  REPORT_MAX_WINDOW_DAYS,
  type AiEvaluationReportDto,
  type ReportSummaryDto,
} from '@smartdesk/contracts';
import { z } from 'zod';
import {
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
} from '../../db/repositories/reports.js';
import { envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';

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

/** Administrator-only aggregate reporting. Mounted under /api/admin/reports. */
export const reportRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    app.get('/summary', { preHandler: app.authGuards.requireRole('ADMIN') }, async (req, reply) => {
      const { start, end } = parse(SummaryQuery, req.query);
      const actor = req.principal!.id;
      const w = { start, end };
      const [routing, firstResponse, resolution, accuracy, acceptance, categories, intake] =
        await Promise.all([
          reportRoutingTime(prisma, actor, w),
          reportFirstResponse(prisma, actor, w),
          reportResolutionTime(prisma, actor, w),
          reportAiAccuracy(prisma, actor, w),
          reportAiAcceptance(prisma, actor, w),
          reportRecurringCategories(prisma, actor, w),
          reportDailyIntake(prisma, actor, w),
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

    app.get(
      '/ai-evaluation',
      { preHandler: app.authGuards.requireRole('ADMIN') },
      async (req, reply) => {
        const { start, end } = parse(SummaryQuery, req.query);
        const actor = req.principal!.id;
        const w = { start, end };
        const [accuracy, acceptance, accByModel, accepByModel, confusion] = await Promise.all([
          reportAiAccuracy(prisma, actor, w),
          reportAiAcceptance(prisma, actor, w),
          reportAiAccuracyByModel(prisma, actor, w),
          reportAiAcceptanceByModel(prisma, actor, w),
          reportAiConfusion(prisma, actor, w),
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
      },
    );
  };
