import type { PrismaClient } from '@smartdesk/db';
import { forbiddenError, validationError } from '../errors.js';
import { loadSql } from '../sql.js';

/**
 * Typed entry points for the reporting and AI-evaluation queries Q05-Q10 (sql/reports/*.sql).
 *
 * - Admin/evaluator scoped: the acting user is re-read from the database and must be an active ADMIN.
 * - Windows are half-open `[start, end)` in UTC, and `start` must be strictly before `end`.
 * - Counts are numbers (0 for an empty cohort); means and percentages are `null` when undefined.
 *   They are never coerced to 0.
 * - Only aggregates leave the database: no ticket text, ids or comments.
 */

export interface ReportWindow {
  start: Date;
  end: Date;
}

async function authorize(prisma: PrismaClient, actorId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: actorId } });
  if (!user?.isActive || user.role !== 'ADMIN') throw forbiddenError();
}

function checkWindow({ start, end }: ReportWindow): [Date, Date] {
  if (!(start instanceof Date) || !(end instanceof Date) || isNaN(+start) || isNaN(+end)) {
    throw validationError('start and end must be valid dates');
  }
  if (start.getTime() >= end.getTime()) throw validationError('start must be before end');
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
  return prisma.$queryRawUnsafe<T[]>(loadSql(`reports/${file}`), start, end);
}

export interface RoutingReport {
  /** Tickets created in the window. */
  submitted: number;
  /** Of those, tickets with a first TEAM_ASSIGNED event (reassignments never replace it). */
  routed: number;
  /** Mean minutes from creation to first routing; null when nothing was routed. */
  avgMinutes: number | null;
}

/** Q05: average time to first approved routing. */
export async function reportRoutingTime(
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

export interface ResolutionReport {
  resolvedTickets: number;
  /** Mean hours from creation to latest resolution; null when no ticket qualifies. */
  avgHours: number | null;
}

/** Q06: average time to resolution (tickets currently RESOLVED/CLOSED, by resolved_at). */
export async function reportResolutionTime(
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

export interface AccuracyReport {
  labelledTickets: number;
  withRecommendation: number;
  correct: number;
  /** Percent of labelled tickets whose first recommendation matched; null with no labelled tickets. */
  accuracyPct: number | null;
}

/** Q07: AI category accuracy against independent reference labels. */
export async function reportAiAccuracy(
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

export interface AcceptanceReport {
  reviewed: number;
  accepted: number;
  /** Percent accepted of reviewed; null when nothing was reviewed. Not the same as accuracy. */
  acceptancePct: number | null;
}

/** Q08: AI recommendation acceptance rate, by review time. */
export async function reportAiAcceptance(
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

export interface CategoryCount {
  category: string;
  ticketCount: number;
}

/** Q09: ticket counts per approved category ('Uncategorized' for tickets without one). */
export async function reportRecurringCategories(
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

export interface DailyIntake {
  /** UTC calendar date, `YYYY-MM-DD`. Days with no tickets are omitted. */
  reportDate: string;
  submittedTickets: number;
}

/** Q10: daily ticket intake by UTC date. */
export async function reportDailyIntake(
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
