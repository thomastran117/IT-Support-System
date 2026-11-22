import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reportAiAccuracy } from '../../src/db/repositories/reports.js';
import { EXPECTED, REPORT_WINDOW, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { computeMetrics, type CasePrediction } from '../../src/modules/ai/evaluation/metrics.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)(
  'evaluation definition matches SQL report Q07 (integration)',
  () => {
    const prisma = createTestPrisma();
    beforeEach(async () => {
      await resetDatabase(prisma);
      await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
    });
    afterAll(async () => {
      await resetDatabase(prisma);
      await prisma.$disconnect();
    });

    /** The harness maths applied to the real rows: labels and each ticket's first recommendation. */
    const harness = async () => {
      const labels = await prisma.classificationLabel.findMany();
      const recs = await prisma.aiRecommendation.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const first = new Map<string, string | null>();
      for (const r of recs) if (!first.has(r.ticketId)) first.set(r.ticketId, r.proposedCategoryId);
      const categories = await prisma.ticketCategory.findMany();
      return computeMetrics(
        labels.map((l) => ({ id: l.ticketId, referenceCategoryId: l.referenceCategoryId })),
        labels.map((l): CasePrediction => {
          const category = first.get(l.ticketId) ?? null;
          return {
            caseId: l.ticketId,
            outcome: category ? 'predicted' : 'missing',
            predictedCategoryId: category,
            errorKind: null,
          };
        }),
        categories.map((c) => ({ id: c.id, name: c.name })),
      );
    };

    it('gives the same counts and accuracy as Q07 on the seeded fixtures', async () => {
      const q07 = await reportAiAccuracy(prisma, USERS.admin, {
        start: new Date(REPORT_WINDOW.start),
        end: new Date(REPORT_WINDOW.end),
      });
      const m = await harness();
      expect(m.total).toBe(q07.labelledTickets);
      expect(m.total - m.missing).toBe(q07.withRecommendation);
      expect(m.correct).toBe(q07.correct);
      expect(Number((m.accuracy! * 100).toFixed(2))).toBe(q07.accuracyPct);
      expect(m.correct).toBe(EXPECTED.q07.correct);
    });

    it('still agrees after a later correct recommendation, which must change nothing', async () => {
      const wrong = await prisma.aiRecommendation.findFirstOrThrow({
        where: { ticket: { label: { isNot: null } } },
        orderBy: { createdAt: 'asc' },
      });
      const label = await prisma.classificationLabel.findUniqueOrThrow({
        where: { ticketId: wrong.ticketId },
      });
      await prisma.aiRecommendation.create({
        data: {
          ticketId: wrong.ticketId,
          proposedCategoryId: label.referenceCategoryId,
          modelVersion: 'later',
          createdAt: new Date('2026-12-01T00:00:00Z'),
        },
      });
      const q07 = await reportAiAccuracy(prisma, USERS.admin, {
        start: new Date(REPORT_WINDOW.start),
        end: new Date(REPORT_WINDOW.end),
      });
      expect((await harness()).correct).toBe(q07.correct);
    });
  },
);
