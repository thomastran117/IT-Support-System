import { createReportQueries } from '@smartdesk/analytics';
import type { PrismaClient } from '@smartdesk/db';
import { describe, expect, it, vi } from 'vitest';

/**
 * SD-053: the report mappers outside PostgreSQL. The SQL computes each ratio with NULLIF on its
 * denominator (covered by the reports integration tests); here the TypeScript side must keep a
 * NULL ratio as null (not 0), convert bigint and numeric strings, and refuse before querying.
 */
const errors = {
  forbidden: () => new Error('forbidden'),
  invalidWindow: (message: string) => new Error(`invalid: ${message}`),
};
const queries = createReportQueries(errors);
const window = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') };
const actorId = '00000000-0000-4000-8000-000000000001';

function fakePrisma(rows: unknown[], user: object | null = { isActive: true, role: 'ADMIN' }) {
  const queryRaw = vi.fn(async () => rows);
  const prisma = {
    user: { findUnique: vi.fn(async () => user) },
    $queryRawUnsafe: queryRaw,
  } as unknown as PrismaClient;
  return { prisma, queryRaw };
}

describe('report queries', () => {
  it('keeps an undefined ratio as null when its denominator is zero', async () => {
    const { prisma } = fakePrisma([{ reviewed: 0n, accepted: 0n, acceptance_pct: null }]);
    expect(await queries.reportAiAcceptance(prisma, actorId, window)).toEqual({
      reviewed: 0,
      accepted: 0,
      acceptancePct: null,
    });

    const accuracy = fakePrisma([
      { labelled_tickets: 0n, with_recommendation: 0n, correct: 0n, accuracy_pct: null },
    ]);
    expect(await queries.reportAiAccuracy(accuracy.prisma, actorId, window)).toMatchObject({
      labelledTickets: 0,
      accuracyPct: null,
    });

    const routing = fakePrisma([{ submitted: 3n, routed: 0n, avg_minutes: null }]);
    expect(await queries.reportRoutingTime(routing.prisma, actorId, window)).toEqual({
      submitted: 3,
      routed: 0,
      avgMinutes: null,
    });

    const resolution = fakePrisma([{ resolved_tickets: 0n, avg_hours: undefined }]);
    expect(await queries.reportResolutionTime(resolution.prisma, actorId, window)).toEqual({
      resolvedTickets: 0,
      avgHours: null,
    });
  });

  it('keeps a real zero as 0 and converts numeric strings and bigints', async () => {
    const { prisma } = fakePrisma([{ reviewed: 4n, accepted: 0n, acceptance_pct: '0.00' }]);
    expect(await queries.reportAiAcceptance(prisma, actorId, window)).toEqual({
      reviewed: 4,
      accepted: 0,
      acceptancePct: 0,
    });
    const response = fakePrisma([{ submitted: 2n, responded: 2n, avg_minutes: '12.50' }]);
    expect(await queries.reportFirstResponse(response.prisma, actorId, window)).toEqual({
      submitted: 2,
      responded: 2,
      avgMinutes: 12.5,
    });
    const models = fakePrisma([
      { model_version: 'fake:v1', reviewed: 0n, accepted: 0n, acceptance_pct: null },
    ]);
    const [model] = await queries.reportAiAcceptanceByModel(models.prisma, actorId, window);
    expect(model).toMatchObject({ acceptancePct: null });
  });

  it('refuses inactive or non-admin actors and invalid windows before any query runs', async () => {
    for (const user of [
      null,
      { isActive: false, role: 'ADMIN' },
      { isActive: true, role: 'TECHNICIAN' },
    ]) {
      const { prisma, queryRaw } = fakePrisma([], user);
      await expect(queries.reportAiAcceptance(prisma, actorId, window)).rejects.toThrow(
        'forbidden',
      );
      expect(queryRaw).not.toHaveBeenCalled();
    }
    for (const bad of [
      { start: window.end, end: window.start },
      { start: window.start, end: window.start },
      { start: new Date('nope'), end: window.end },
    ]) {
      const { prisma, queryRaw } = fakePrisma([]);
      await expect(queries.reportAiAcceptance(prisma, actorId, bad)).rejects.toThrow(/^invalid/);
      expect(queryRaw).not.toHaveBeenCalled();
    }
  });

  it('passes the window as bound parameters, never inside the SQL text', async () => {
    const { prisma, queryRaw } = fakePrisma([{ reviewed: 0n, accepted: 0n, acceptance_pct: null }]);
    await queries.reportAiAcceptance(prisma, actorId, window);
    const [sql, start, end] = queryRaw.mock.calls[0] as unknown as [string, Date, Date];
    expect(start).toBe(window.start);
    expect(end).toBe(window.end);
    expect(sql).toContain('$1');
    expect(sql).not.toContain('2026-03-01');
  });
});
