import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../src/db/errors.js';
import {
  reportAiAcceptance,
  reportAiAccuracy,
  reportDailyIntake,
  reportRecurringCategories,
  reportResolutionTime,
  reportRoutingTime,
  type ReportWindow,
} from '../../src/db/repositories/reports.js';
import {
  EMPTY_WINDOW,
  EXPECTED,
  RECOMMENDATIONS,
  REPORT_WINDOW,
  TICKETS,
  USERS,
  uuid,
} from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const win = (start: string, end: string): ReportWindow => ({
  start: new Date(start),
  end: new Date(end),
});
const MARCH = win(REPORT_WINDOW.start, REPORT_WINDOW.end);
const EMPTY = win(EMPTY_WINDOW.start, EMPTY_WINDOW.end);

describe.skipIf(!testDatabaseUrl)('report queries Q05-Q10 (integration)', () => {
  const prisma = createTestPrisma();
  const admin = USERS.admin;

  beforeEach(async () => {
    await seedDatabase(prisma, { profile: 'test', reset: true, databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  const sql = (statement: string, ...params: unknown[]) =>
    prisma.$executeRawUnsafe(statement, ...params);
  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(DbError);
      return (err as DbError).code;
    }
    throw new Error('expected a rejection');
  };

  describe('hand-calculated fixture results (March 2026)', () => {
    it('Q05: 9 submitted, 6 routed, mean 25.00 minutes; reassignment does not replace first routing', async () => {
      expect(await reportRoutingTime(prisma, admin, MARCH)).toEqual({
        submitted: EXPECTED.q05.submitted,
        routed: EXPECTED.q05.routed,
        avgMinutes: 25,
      });
      // Only the rerouted ticket (created 10:00, TEAM_ASSIGNED 10:10, TEAM_REASSIGNED 11:00).
      expect(
        await reportRoutingTime(prisma, admin, win('2026-03-03T10:00:00Z', '2026-03-03T10:00:01Z')),
      ).toEqual({ submitted: 1, routed: 1, avgMinutes: 10 });
    });

    it('Q06: 2 resolved, mean 16.00 hours; the reopened ticket is excluded', async () => {
      expect(await reportResolutionTime(prisma, admin, MARCH)).toEqual({
        resolvedTickets: EXPECTED.q06.resolvedTickets,
        avgHours: 16,
      });
    });

    it('Q06: a reopened ticket counts again once it is resolved again', async () => {
      await sql(
        `UPDATE tickets SET status = 'RESOLVED', resolved_at = $2::timestamptz,
                resolution_summary = 'Fixed for good'
         WHERE ticket_id = $1::uuid`,
        TICKETS.reopened,
        '2026-03-10T12:00:00Z',
      );
      // created 03-06 11:00 -> resolved 03-10 12:00 = 97 h; (8 + 24 + 97) / 3 = 43
      expect(await reportResolutionTime(prisma, admin, MARCH)).toEqual({
        resolvedTickets: 3,
        avgHours: 43,
      });
    });

    it('Q07: 5 labelled, 4 with a recommendation, 2 correct, 40.00%', async () => {
      expect(await reportAiAccuracy(prisma, admin, MARCH)).toEqual({
        labelledTickets: EXPECTED.q07.labelledTickets,
        withRecommendation: EXPECTED.q07.withRecommendation,
        correct: EXPECTED.q07.correct,
        accuracyPct: 40,
      });
    });

    it('Q07: only the first recommendation counts, and a missing category is incorrect', async () => {
      // A later, correct recommendation on a ticket whose first one was wrong must change nothing...
      await sql(
        `INSERT INTO ai_recommendations (ticket_id, proposed_category_id, model_version, created_at)
         VALUES ($1::uuid, $2::uuid, 'fixture-model-2', $3::timestamptz)`,
        TICKETS.license,
        uuid('category', 2), // Software = the reference label
        '2026-03-03T13:00:00Z',
      );
      expect((await reportAiAccuracy(prisma, admin, MARCH)).correct).toBe(2);
      // ...but clearing the first recommendation's category makes that ticket incorrect.
      await sql(
        `UPDATE ai_recommendations SET proposed_category_id = NULL WHERE recommendation_id = $1::uuid`,
        RECOMMENDATIONS.vpnAccepted,
      );
      expect(await reportAiAccuracy(prisma, admin, MARCH)).toEqual({
        labelledTickets: 5,
        withRecommendation: 4,
        correct: 1,
        accuracyPct: 20,
      });
    });

    it('Q07: restricts the cohort by ticket creation time', async () => {
      // password (03-04, correct) and monitor (03-05, wrong): 50.00%
      expect(
        await reportAiAccuracy(prisma, admin, win('2026-03-04T00:00:00Z', '2026-03-06T00:00:00Z')),
      ).toEqual({ labelledTickets: 2, withRecommendation: 2, correct: 1, accuracyPct: 50 });
    });

    it('Q08: 4 reviewed, 2 accepted, 50.00%; overridden and rejected count against acceptance', async () => {
      expect(await reportAiAcceptance(prisma, admin, MARCH)).toEqual({
        reviewed: EXPECTED.q08.reviewed,
        accepted: EXPECTED.q08.accepted,
        acceptancePct: 50,
      });
      // license OVERRIDDEN (03-03), password ACCEPTED (03-04), monitor REJECTED (03-05): 1/3
      expect(
        await reportAiAcceptance(
          prisma,
          admin,
          win('2026-03-03T00:00:00Z', '2026-03-06T00:00:00Z'),
        ),
      ).toEqual({ reviewed: 3, accepted: 1, acceptancePct: 33.33 });
      // PENDING recommendations are never counted: nothing was reviewed on 03-09.
      expect(
        await reportAiAcceptance(
          prisma,
          admin,
          win('2026-03-09T00:00:00Z', '2026-03-10T00:00:00Z'),
        ),
      ).toEqual({ reviewed: 0, accepted: 0, acceptancePct: null });
    });

    it('Q09: category counts including Uncategorized, ordered by count then name', async () => {
      expect(await reportRecurringCategories(prisma, admin, MARCH)).toEqual(EXPECTED.q09);
    });

    it('Q10: daily intake by UTC date, omitting empty days', async () => {
      expect(await reportDailyIntake(prisma, admin, MARCH)).toEqual(EXPECTED.q10);
    });

    it("Q10: groups by UTC date, not by the writer's local time zone", async () => {
      const insert = (n: number, at: string) =>
        sql(
          `INSERT INTO tickets (ticket_id, requester_id, title, description, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, 'tz', 'tz', $3::timestamptz, $3::timestamptz)`,
          uuid('ticket', 200 + n),
          USERS.erin,
          at,
        );
      await insert(1, '2026-03-12T23:59:59Z'); // 03-12 in UTC
      await insert(2, '2026-03-12T23:30:00-05:00'); // 03-13 04:30 in UTC
      expect(
        await reportDailyIntake(prisma, admin, win('2026-03-12T00:00:00Z', '2026-03-14T00:00:00Z')),
      ).toEqual([
        { reportDate: '2026-03-12', submittedTickets: 1 },
        { reportDate: '2026-03-13', submittedTickets: 1 },
      ]);
    });
  });

  describe('empty cohorts', () => {
    it('return zero counts and NULL (never 0) for undefined means and percentages', async () => {
      expect(await reportRoutingTime(prisma, admin, EMPTY)).toEqual({
        submitted: 0,
        routed: 0,
        avgMinutes: null,
      });
      expect(await reportResolutionTime(prisma, admin, EMPTY)).toEqual({
        resolvedTickets: 0,
        avgHours: null,
      });
      expect(await reportAiAccuracy(prisma, admin, EMPTY)).toEqual({
        labelledTickets: 0,
        withRecommendation: 0,
        correct: 0,
        accuracyPct: null,
      });
      expect(await reportAiAcceptance(prisma, admin, EMPTY)).toEqual({
        reviewed: 0,
        accepted: 0,
        acceptancePct: null,
      });
      expect(await reportRecurringCategories(prisma, admin, EMPTY)).toEqual([]);
      expect(await reportDailyIntake(prisma, admin, EMPTY)).toEqual([]);
    });

    it('Q05: tickets exist but none were routed, so the mean is NULL', async () => {
      // 03-09 holds only unrouted tickets (aiDown, token).
      expect(
        await reportRoutingTime(prisma, admin, win('2026-03-09T00:00:00Z', '2026-03-10T00:00:00Z')),
      ).toEqual({ submitted: 2, routed: 0, avgMinutes: null });
    });

    it('Q07: tickets exist but none is labelled', async () => {
      expect(
        await reportAiAccuracy(prisma, admin, win('2026-03-06T00:00:00Z', '2026-03-07T00:00:00Z')),
      ).toEqual({ labelledTickets: 0, withRecommendation: 0, correct: 0, accuracyPct: null });
    });
  });

  describe('date boundaries', () => {
    it('includes the start instant and excludes the end instant', async () => {
      // boundary was created exactly at 03-01 00:00:00; printer exactly at the window end 09:00 on 03-02.
      const result = await reportDailyIntake(
        prisma,
        admin,
        win('2026-03-01T00:00:00Z', '2026-03-02T09:00:00Z'),
      );
      expect(result).toEqual([{ reportDate: '2026-03-01', submittedTickets: 1 }]);
      // afterWindow (04-01 00:00:00) is outside March, and inside the window that starts at it.
      expect((await reportRoutingTime(prisma, admin, MARCH)).submitted).toBe(9);
      expect(
        (
          await reportRoutingTime(
            prisma,
            admin,
            win('2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z'),
          )
        ).submitted,
      ).toBe(1);
    });

    it('treats reviewed_at and resolved_at windows as half-open as well', async () => {
      // monitor resolved exactly 03-06 09:00:00
      expect(
        (
          await reportResolutionTime(
            prisma,
            admin,
            win('2026-03-06T09:00:00Z', '2026-03-07T00:00:00Z'),
          )
        ).resolvedTickets,
      ).toBe(1);
      expect(
        (
          await reportResolutionTime(
            prisma,
            admin,
            win('2026-03-05T00:00:00Z', '2026-03-06T09:00:00Z'),
          )
        ).resolvedTickets,
      ).toBe(0);
    });
  });

  describe('access and validation', () => {
    it('requires start before end and valid dates', async () => {
      const same = win('2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');
      expect(await rejection(reportDailyIntake(prisma, admin, same))).toBe('VALIDATION');
      expect(
        await rejection(
          reportRoutingTime(prisma, admin, win('2026-03-02T00:00:00Z', '2026-03-01T00:00:00Z')),
        ),
      ).toBe('VALIDATION');
      expect(
        await rejection(
          reportAiAcceptance(prisma, admin, { start: new Date('nope'), end: new Date() }),
        ),
      ).toBe('VALIDATION');
    });

    it('is limited to active administrators', async () => {
      for (const actor of [USERS.tara, USERS.erin, USERS.ingrid, uuid('user', 999)]) {
        expect(await rejection(reportRoutingTime(prisma, actor, MARCH))).toBe('FORBIDDEN');
        expect(await rejection(reportRecurringCategories(prisma, actor, MARCH))).toBe('FORBIDDEN');
      }
    });

    it('returns aggregates only, with no ticket text or ids', async () => {
      const keys = Object.keys(await reportRoutingTime(prisma, admin, MARCH)).sort();
      expect(keys).toEqual(['avgMinutes', 'routed', 'submitted']);
      const categories = JSON.stringify(await reportRecurringCategories(prisma, admin, MARCH));
      expect(categories).not.toMatch(/printer|VPN disconnects|[0-9a-f]{8}-0000-4000/);
    });
  });

  describe('SQL files', () => {
    it('are stored in source control with bound parameters only', () => {
      for (const file of [
        'Q05_avg_time_to_first_routing',
        'Q06_avg_time_to_resolution',
        'Q07_ai_category_accuracy',
        'Q08_ai_acceptance_rate',
        'Q09_recurring_categories',
        'Q10_daily_ticket_intake',
        'Q11_avg_time_to_first_response',
        'Q12_ai_accuracy_by_model',
        'Q13_ai_acceptance_by_model',
        'Q14_ai_confusion',
      ]) {
        const path = new URL(`../../../packages/analytics/sql/${file}.sql`, import.meta.url);
        const text = readFileSync(path, 'utf8');
        expect(text).toMatch(/^-- Q\d\d/);
        expect(text).toContain('$1::timestamptz');
        expect(text).toContain('$2::timestamptz');
      }
    });
  });
});
