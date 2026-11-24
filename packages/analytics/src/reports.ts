import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@smartdesk/db';

const queries = new Map<string, string>();
function loadSql(file: string): string {
  let sql = queries.get(file);
  if (!sql) {
    sql = readFileSync(new URL(`../sql/${file}`, import.meta.url), 'utf8');
    queries.set(file, sql);
  }
  return sql;
}

export interface ReportWindow {
  start: Date;
  end: Date;
}

export interface RoutingReport {
  /** Tickets created in the window. */
  submitted: number;
  /** Of those, tickets with a first TEAM_ASSIGNED event (reassignments never replace it). */
  routed: number;
  /** Mean minutes from creation to first routing; null when nothing was routed. */
  avgMinutes: number | null;
}

export interface FirstResponseReport {
  /** Tickets created in the window. */
  submitted: number;
  /** Of those, tickets with a first public technician response. */
  responded: number;
  /** Mean minutes from creation to first public response; null when none were answered. */
  avgMinutes: number | null;
}

export interface ResolutionReport {
  resolvedTickets: number;
  /** Mean hours from creation to latest resolution; null when no ticket qualifies. */
  avgHours: number | null;
}

export interface AccuracyReport {
  labelledTickets: number;
  withRecommendation: number;
  correct: number;
  /** Percent of labelled tickets whose first recommendation matched; null with no labelled tickets. */
  accuracyPct: number | null;
}

export interface AcceptanceReport {
  reviewed: number;
  accepted: number;
  /** Percent accepted of reviewed; null when nothing was reviewed. Not the same as accuracy. */
  acceptancePct: number | null;
}

export interface CategoryCount {
  category: string;
  ticketCount: number;
}

export interface DailyIntake {
  /** UTC calendar date, `YYYY-MM-DD`. Days with no tickets are omitted. */
  reportDate: string;
  submittedTickets: number;
}

export interface ModelAccuracy {
  modelVersion: string;
  /** Labelled tickets whose first valid recommendation came from this model version. */
  labelledTickets: number;
  correct: number;
  accuracyPct: number | null;
}

export interface ModelAcceptance {
  modelVersion: string;
  reviewed: number;
  accepted: number;
  acceptancePct: number | null;
}

export interface ConfusionCell {
  referenceCategory: string;
  /** null when the labelled ticket has no valid recommendation. */
  predictedCategory: string | null;
  ticketCount: number;
}

/** Shared report queries over Ticket's committed facts. Each query rechecks the active admin. */
export function createReportQueries(errors: {
  forbidden: () => Error;
  invalidWindow: (message: string) => Error;
}) {
  async function authorize(prisma: PrismaClient, actorId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: actorId },
      select: { isActive: true, role: true },
    });
    if (!user?.isActive || user.role !== 'ADMIN') throw errors.forbidden();
  }

  function checkWindow({ start, end }: ReportWindow): [Date, Date] {
    if (!(start instanceof Date) || !(end instanceof Date) || isNaN(+start) || isNaN(+end)) {
      throw errors.invalidWindow('start and end must be valid dates');
    }
    if (start.getTime() >= end.getTime()) throw errors.invalidWindow('start must be before end');
    return [start, end];
  }

  const num = (v: unknown): number => Number(String(v));
  const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

  async function run<T>(
    prisma: PrismaClient,
    actorId: string,
    file: string,
    window: ReportWindow,
  ): Promise<T[]> {
    await authorize(prisma, actorId);
    const [start, end] = checkWindow(window);
    return prisma.$queryRawUnsafe<T[]>(loadSql(file), start, end);
  }

  /** Q05: average time to first approved routing. */
  async function reportRoutingTime(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<RoutingReport> {
    const [r] = await run<{ submitted: bigint; routed: bigint; avg_minutes: unknown }>(
      prisma,
      actorId,
      'Q05_avg_time_to_first_routing.sql',
      window,
    );
    return {
      submitted: num(r!.submitted),
      routed: num(r!.routed),
      avgMinutes: numOrNull(r!.avg_minutes),
    };
  }

  /** Q11: average time to first public technician response (cohort: tickets created in window). */
  async function reportFirstResponse(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<FirstResponseReport> {
    const [r] = await run<{ submitted: bigint; responded: bigint; avg_minutes: unknown }>(
      prisma,
      actorId,
      'Q11_avg_time_to_first_response.sql',
      window,
    );
    return {
      submitted: num(r!.submitted),
      responded: num(r!.responded),
      avgMinutes: numOrNull(r!.avg_minutes),
    };
  }

  /** Q06: average time to resolution (tickets currently RESOLVED/CLOSED, by resolved_at). */
  async function reportResolutionTime(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<ResolutionReport> {
    const [r] = await run<{ resolved_tickets: bigint; avg_hours: unknown }>(
      prisma,
      actorId,
      'Q06_avg_time_to_resolution.sql',
      window,
    );
    return { resolvedTickets: num(r!.resolved_tickets), avgHours: numOrNull(r!.avg_hours) };
  }

  /** Q07: AI category accuracy against independent reference labels (first valid recommendation). */
  async function reportAiAccuracy(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<AccuracyReport> {
    const [r] = await run<{
      labelled_tickets: bigint;
      with_recommendation: bigint;
      correct: bigint;
      accuracy_pct: unknown;
    }>(prisma, actorId, 'Q07_ai_category_accuracy.sql', window);
    return {
      labelledTickets: num(r!.labelled_tickets),
      withRecommendation: num(r!.with_recommendation),
      correct: num(r!.correct),
      accuracyPct: numOrNull(r!.accuracy_pct),
    };
  }

  /** Q08: AI recommendation acceptance rate, by review time. */
  async function reportAiAcceptance(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<AcceptanceReport> {
    const [r] = await run<{ reviewed: bigint; accepted: bigint; acceptance_pct: unknown }>(
      prisma,
      actorId,
      'Q08_ai_acceptance_rate.sql',
      window,
    );
    return {
      reviewed: num(r!.reviewed),
      accepted: num(r!.accepted),
      acceptancePct: numOrNull(r!.acceptance_pct),
    };
  }

  /** Q09: ticket counts per approved category ('Uncategorized' for tickets without one). */
  async function reportRecurringCategories(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<CategoryCount[]> {
    const rows = await run<{ category: string; ticket_count: bigint }>(
      prisma,
      actorId,
      'Q09_recurring_categories.sql',
      window,
    );
    return rows.map((r) => ({ category: r.category, ticketCount: num(r.ticket_count) }));
  }

  /** Q10: daily ticket intake by UTC date. */
  async function reportDailyIntake(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<DailyIntake[]> {
    const rows = await run<{ report_date: Date; submitted_tickets: bigint }>(
      prisma,
      actorId,
      'Q10_daily_ticket_intake.sql',
      window,
    );
    return rows.map((r) => ({
      reportDate: r.report_date.toISOString().slice(0, 10),
      submittedTickets: num(r.submitted_tickets),
    }));
  }

  /** Q12: accuracy per model version (tickets without any valid recommendation have no model). */
  async function reportAiAccuracyByModel(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<ModelAccuracy[]> {
    const rows = await run<{
      model_version: string;
      labelled_tickets: bigint;
      correct: bigint;
      accuracy_pct: unknown;
    }>(prisma, actorId, 'Q12_ai_accuracy_by_model.sql', window);
    return rows.map((r) => ({
      modelVersion: r.model_version,
      labelledTickets: num(r.labelled_tickets),
      correct: num(r.correct),
      accuracyPct: numOrNull(r.accuracy_pct),
    }));
  }

  /** Q13: review acceptance per model version, by review time. */
  async function reportAiAcceptanceByModel(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<ModelAcceptance[]> {
    const rows = await run<{
      model_version: string;
      reviewed: bigint;
      accepted: bigint;
      acceptance_pct: unknown;
    }>(prisma, actorId, 'Q13_ai_acceptance_by_model.sql', window);
    return rows.map((r) => ({
      modelVersion: r.model_version,
      reviewed: num(r.reviewed),
      accepted: num(r.accepted),
      acceptancePct: numOrNull(r.acceptance_pct),
    }));
  }

  /** Q14: reference category against the first valid recommended category. */
  async function reportAiConfusion(
    prisma: PrismaClient,
    actorId: string,
    window: ReportWindow,
  ): Promise<ConfusionCell[]> {
    const rows = await run<{
      reference_category: string;
      predicted_category: string | null;
      ticket_count: bigint;
    }>(prisma, actorId, 'Q14_ai_confusion.sql', window);
    return rows.map((r) => ({
      referenceCategory: r.reference_category,
      predictedCategory: r.predicted_category,
      ticketCount: num(r.ticket_count),
    }));
  }

  return {
    reportRoutingTime,
    reportFirstResponse,
    reportResolutionTime,
    reportAiAccuracy,
    reportAiAcceptance,
    reportRecurringCategories,
    reportDailyIntake,
    reportAiAccuracyByModel,
    reportAiAcceptanceByModel,
    reportAiConfusion,
  };
}
