import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compare,
  CSV_HEADER,
  improvement,
  parseObservations,
  renderReport,
  stats,
} from '../../../src/modules/baseline/routingBaseline.js';

const HEADER = CSV_HEADER.join(',');
const T0 = Date.parse('2026-03-02T09:00:00Z');

/** CSV rows whose routing time is exactly the given number of minutes. */
function csv(rows: { id: string; category?: string; minutes: number | null; note?: string }[]) {
  const lines = rows.map((r) => {
    const start = new Date(T0).toISOString();
    const end = r.minutes === null ? '' : new Date(T0 + r.minutes * 60_000).toISOString();
    return [r.id, r.category ?? 'Hardware', start, end, r.note ?? ''].join(',');
  });
  return [HEADER, ...lines].join('\n');
}
const parse = (rows: Parameters<typeof csv>[0]) => parseObservations(csv(rows));
const many = (prefix: string, minutes: number[], category = 'Hardware') =>
  minutes.map((m, i) => ({ id: `${prefix}${i}`, minutes: m, category }));

describe('parseObservations', () => {
  it('reads routed and unrouted rows, comments and blank lines', () => {
    const p = parseObservations(
      [
        HEADER,
        '# a comment',
        '',
        'a,Hardware,2026-03-02T09:00:00Z,2026-03-02T09:30:00Z,first',
        'b,Software,2026-03-02T10:00:00+00:00,,never routed',
        'c,"Net, VPN",2026-03-02T11:00:00Z,2026-03-02T11:05:00Z,',
      ].join('\r\n'),
    );
    expect(p.invalid).toEqual([]);
    expect(p.observations.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(p.observations[1]!.assignedAt).toBeNull();
    expect(p.observations[2]!.category).toBe('Net, VPN');
  });

  it('reports unusable rows instead of dropping them silently', () => {
    const p = parseObservations(
      [
        HEADER,
        ',Hardware,2026-03-02T09:00:00Z,2026-03-02T09:30:00Z,',
        'x,,2026-03-02T09:00:00Z,2026-03-02T09:30:00Z,',
        'y,Hardware,2026-03-02 09:00,2026-03-02T09:30:00Z,',
        'z,Hardware,2026-03-02T09:00:00Z,soon,',
        'w,Hardware,2026-03-02T09:30:00Z,2026-03-02T09:00:00Z,',
        'ok,Hardware,2026-03-02T09:00:00Z,2026-03-02T09:30:00Z,',
      ].join('\n'),
    );
    expect(p.observations.map((o) => o.id)).toEqual(['ok']);
    expect(p.invalid.map((i) => [i.line, i.reason])).toEqual([
      [2, 'missing observation_id'],
      [3, 'missing category'],
      [4, 'started_at must be an ISO-8601 time with an offset'],
      [5, 'assigned_at must be blank or an ISO-8601 time with an offset'],
      [6, 'assigned_at is before started_at'],
    ]);
  });

  it('rejects a wrong header and duplicate ids', () => {
    expect(() => parseObservations('id,cat\n')).toThrow(/Header must be/);
    expect(() =>
      parseObservations(
        [HEADER, 'a,Hardware,2026-03-02T09:00:00Z,,', 'a,Hardware,2026-03-02T09:00:00Z,,'].join(
          '\n',
        ),
      ),
    ).toThrow(/Duplicate observation_id "a"/);
  });
});

describe('manual observation template', () => {
  it('parses cleanly and holds no data rows', () => {
    const template = readFileSync(
      new URL(
        '../../../../docs/testing/routing-baseline/manual-observations.template.csv',
        import.meta.url,
      ),
      'utf8',
    );
    expect(parseObservations(template)).toEqual({ observations: [], invalid: [] });
  });
});

describe('stats', () => {
  it('computes the hand-calculated figures', () => {
    // 10, 20, 30, 40: mean 25, median 25, sample SD sqrt((225+25+25+225)/3) = 12.91
    expect(stats([30, 10, 40, 20])).toEqual({
      n: 4,
      meanMinutes: 25,
      medianMinutes: 25,
      sdMinutes: 12.91,
      minMinutes: 10,
      maxMinutes: 40,
    });
    expect(stats([7, 3, 5]).medianMinutes).toBe(5);
  });

  it('gives null, not zero, when there is nothing to average', () => {
    expect(stats([])).toEqual({
      n: 0,
      meanMinutes: null,
      medianMinutes: null,
      sdMinutes: null,
      minMinutes: null,
      maxMinutes: null,
    });
    expect(stats([5]).sdMinutes).toBeNull();
  });
});

describe('improvement', () => {
  it('is (manual - assisted) / manual * 100', () => {
    expect(improvement(40, 20)).toBe(50);
    expect(improvement(40, 25)).toBe(37.5);
    expect(improvement(40, 50)).toBe(-25); // slower than manual is a negative improvement
  });
  it('is undefined without data or with a non-positive manual mean', () => {
    expect(improvement(null, 5)).toBeNull();
    expect(improvement(5, null)).toBeNull();
    expect(improvement(0, 5)).toBeNull();
  });
});

describe('compare', () => {
  const manualMinutes = [20, 30, 40, 50, 60, 20, 30, 40, 50, 60]; // mean 40
  it('meets the target at exactly 50% (manual 40, assisted 20)', () => {
    const r = compare(
      parse(many('m', manualMinutes)),
      parse(many('s', [10, 15, 20, 25, 30, 10, 15, 20, 25, 30])), // mean 20
    );
    expect(r.manual).toMatchObject({ n: 10, meanMinutes: 40, unrouted: 0, observed: 10 });
    expect(r.assisted).toMatchObject({ n: 10, meanMinutes: 20 });
    expect(r.improvementPct).toBe(50);
    expect(r.verdict).toBe('MET');
  });

  it('does not meet it at 37.5% (assisted mean 25)', () => {
    const r = compare(
      parse(many('m', manualMinutes)),
      parse(many('s', [15, 20, 25, 30, 35, 15, 20, 25, 30, 35])),
    );
    expect(r.improvementPct).toBe(37.5);
    expect(r.verdict).toBe('NOT_MET');
  });

  it('reports a negative improvement when assisted routing is slower', () => {
    const r = compare(
      parse(many('m', manualMinutes)),
      parse(many('s', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50])),
    );
    expect(r.improvementPct).toBe(-25);
    expect(r.verdict).toBe('NOT_MET');
  });

  it('makes no claim below the minimum sample, however good the numbers look', () => {
    const r = compare(parse(many('m', [40, 40, 40])), parse(many('s', [1, 1, 1])));
    expect(r.improvementPct).toBe(97.5);
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.verdictReason).toMatch(/Fewer than 10/);
    expect(
      compare(parse(many('m', [40, 40, 40])), parse(many('s', [1, 1, 1])), { minSample: 3 })
        .verdict,
    ).toBe('MET');
  });

  it('excludes unrouted tickets from the mean and discloses them', () => {
    const manual = parse([...many('m', manualMinutes), { id: 'u1', minutes: null }]);
    const assisted = parse([
      ...many('s', [10, 15, 20, 25, 30, 10, 15, 20, 25, 30]),
      { id: 'u2', minutes: null },
      { id: 'u3', minutes: null },
    ]);
    const r = compare(manual, assisted);
    expect(r.manual).toMatchObject({ observed: 11, n: 10, unrouted: 1, meanMinutes: 40 });
    expect(r.assisted).toMatchObject({ observed: 12, n: 10, unrouted: 2, meanMinutes: 20 });
  });

  it('counts invalid rows and is inconclusive with no routed data', () => {
    const bad = parseObservations(`${HEADER}\nx,Hardware,nonsense,,\n`);
    const r = compare(bad, parse([]));
    expect(r.manual.invalid).toBe(1);
    expect(r.improvementPct).toBeNull();
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.manual.meanMinutes).toBeNull();
  });

  it('decides on the unrounded improvement, so rounding cannot flip the verdict', () => {
    // manual 1000 min, assisted 500.04 min: 49.996 percent, displayed as 50 but below target.
    const r = compare(
      parse(many('m', Array(10).fill(1000))),
      parse(many('s', Array(10).fill(500.04))),
    );
    expect(r.improvementPct).toBe(50);
    expect(r.verdict).toBe('NOT_MET');
  });

  it('flags category-mix differences between the cohorts', () => {
    const manual = parse([
      ...many('m', Array(8).fill(30), 'Hardware'),
      ...many('n', Array(2).fill(30), 'Software'),
    ]);
    const assisted = parse([
      ...many('s', Array(3).fill(10), 'Hardware'),
      ...many('t', Array(7).fill(10), 'Software'),
      ...many('u', [10], 'Network'),
    ]);
    const r = compare(manual, assisted);
    expect(r.categoryMix.find((c) => c.category === 'Hardware')).toMatchObject({
      manual: 8,
      assisted: 3,
      manualSharePct: 80,
      assistedSharePct: 27.27,
    });
    expect(r.comparabilityWarnings).toEqual([
      'Hardware is 80% of manual but 27.27% of assisted observations.',
      'Network appears in only one cohort (manual 0, assisted 1).',
      'Software is 20% of manual but 63.64% of assisted observations.',
    ]);
  });

  it('renders every input to the headline number', () => {
    const r = compare(
      parse(many('m', manualMinutes)),
      parse(many('s', [10, 15, 20, 25, 30, 10, 15, 20, 25, 30])),
    );
    const md = renderReport(r, {
      manualFile: 'manual.csv',
      assistedFile: 'assisted.csv',
      generatedAt: '2026-03-01T00:00:00Z',
    });
    expect(md).toContain('Verdict against the 50% target: MET');
    expect(md).toContain('Manual mean: 40 min (n = 10)');
    expect(md).toContain('SmartDesk-assisted mean: 20 min (n = 10)');
    expect(md).toContain('= **50%**');
    expect(md).toContain('| Manual triage | 10 | 10 | 0 | 0 | 40 |');
    expect(md).toContain('not randomised');
  });
});
