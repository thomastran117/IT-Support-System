import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportRoutingTime } from '../../src/db/repositories/reports.js';
import {
  EMPTY_WINDOW,
  EXPECTED,
  REPORT_WINDOW,
  TICKETS,
  USERS,
} from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import { loadSql } from '../../src/db/sql.js';
import { exportAssistedObservations } from '../../src/modules/baseline/export.js';
import { compare, parseObservations } from '../../src/modules/baseline/routingBaseline.js';
import { createTestPrisma, resetDatabase, testDatabaseUrl } from './helpers/db.js';

const MARCH = { start: new Date(REPORT_WINDOW.start), end: new Date(REPORT_WINDOW.end) };
const EMPTY = { start: new Date(EMPTY_WINDOW.start), end: new Date(EMPTY_WINDOW.end) };
const none = parseObservations('observation_id,category,started_at,assigned_at,note\n');

describe.skipIf(!testDatabaseUrl)('routing baseline export (integration)', () => {
  const prisma = createTestPrisma();

  beforeAll(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });
  });
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('exports the same cohort and first-routing times as report Q05', async () => {
    const { csv, rows } = await exportAssistedObservations(prisma, MARCH, {
      aiAssistedOnly: false,
    });
    expect(rows).toBe(EXPECTED.q05.submitted);
    const assisted = parseObservations(csv);
    expect(assisted.invalid).toEqual([]);
    const r = compare(none, assisted);
    // Q05: 9 submitted, 6 routed, mean 25.00 minutes; the 3 unrouted are disclosed, not averaged.
    expect(r.assisted).toMatchObject({
      observed: EXPECTED.q05.submitted,
      n: EXPECTED.q05.routed,
      unrouted: 3,
      meanMinutes: 25,
    });
    const q05 = await reportRoutingTime(prisma, USERS.admin, MARCH);
    expect(r.assisted.meanMinutes).toBe(q05.avgMinutes);
    expect(r.assisted.n).toBe(q05.routed);
  });

  it('can be limited to tickets whose AI recommendation was accepted or overridden', async () => {
    const { csv, rows } = await exportAssistedObservations(prisma, MARCH, { aiAssistedOnly: true });
    expect(rows).toBe(3); // vpn (accepted), license (overridden), password (accepted)
    const ids = parseObservations(csv).observations.map((o) => o.id);
    expect(ids.sort()).toEqual([TICKETS.vpn, TICKETS.license, TICKETS.password].sort());
  });

  it('exports half-open windows and nothing for an empty one', async () => {
    const { csv, rows } = await exportAssistedObservations(prisma, EMPTY, {
      aiAssistedOnly: false,
    });
    expect(rows).toBe(0);
    expect(parseObservations(csv).observations).toEqual([]);
    const ids = parseObservations(
      (await exportAssistedObservations(prisma, MARCH, { aiAssistedOnly: false })).csv,
    ).observations.map((o) => o.id);
    expect(ids).toContain(TICKETS.boundary); // created exactly at the window start
    expect(ids).not.toContain(TICKETS.afterWindow); // created exactly at the window end
  });

  it('exports only ids, categories and times: no requester or ticket text', async () => {
    const { csv } = await exportAssistedObservations(prisma, MARCH, { aiAssistedOnly: false });
    expect(csv).not.toMatch(/@smartdesk\.test/);
    expect(csv.split('\n')[0]).toBe('observation_id,category,started_at,assigned_at,note');
    // Only the statement itself: the header comment names the columns it deliberately omits.
    const sql = loadSql('baseline/assisted_routing_observations.sql').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(title|description|display_name|email|body)\b/);
  });

  it('rejects a reversed window', async () => {
    await expect(
      exportAssistedObservations(
        prisma,
        { start: MARCH.end, end: MARCH.start },
        { aiAssistedOnly: false },
      ),
    ).rejects.toThrow(/start must be before end/);
  });
});
