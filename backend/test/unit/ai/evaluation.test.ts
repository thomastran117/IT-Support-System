import { describe, expect, it } from 'vitest';
import { buildFixtures, EXPECTED } from '../../../src/db/seed/fixtures.js';
import { PROMPT_VERSION } from '../../../src/modules/ai/prompt.js';
import { createKeywordBaseline } from '../../../src/modules/ai/evaluation/baseline.js';
import {
  ALLOWED_TEAMS_BY_CATEGORY,
  DATASET_VERSION,
  EVAL_CASES,
  EVAL_CATEGORIES,
  datasetHash,
  type EvalCase,
} from '../../../src/modules/ai/evaluation/dataset.js';
import {
  MISSING,
  computeMetrics,
  pct,
  wilson95,
  type CasePrediction,
} from '../../../src/modules/ai/evaluation/metrics.js';
import { renderReport } from '../../../src/modules/ai/evaluation/report.js';
import {
  PROMPT_HASHES,
  assertPromptPinned,
  runEvaluation,
} from '../../../src/modules/ai/evaluation/run.js';
import {
  ProviderError,
  validateProposal,
  type AIProvider,
  type AnalysisRequest,
} from '../../../src/modules/ai/provider.js';
import { createFakeProvider } from '../../../src/modules/ai/providers/fake.js';
import { redactText } from '../../../src/modules/ai/redact.js';

const cats = [
  { id: 'c1', name: 'A' },
  { id: 'c2', name: 'B' },
  { id: 'c3', name: 'C' },
];
const pred = (
  caseId: string,
  outcome: CasePrediction['outcome'],
  predictedCategoryId: string | null = null,
): CasePrediction => ({ caseId, outcome, predictedCategoryId, errorKind: null });

describe('computeMetrics (hand-calculated)', () => {
  const cases = [
    { id: '1', referenceCategoryId: 'c1' },
    { id: '2', referenceCategoryId: 'c1' },
    { id: '3', referenceCategoryId: 'c2' },
    { id: '4', referenceCategoryId: 'c2' },
    { id: '5', referenceCategoryId: 'c3' },
  ];

  it('counts wrong, invalid and missing answers against ALL labelled cases', () => {
    const m = computeMetrics(
      cases,
      [
        pred('1', 'predicted', 'c1'), // correct
        pred('2', 'predicted', 'c1'), // correct
        pred('3', 'predicted', 'c1'), // wrong category
        pred('4', 'invalid'), // answered but unusable
        // case 5: no prediction at all -> missing
      ],
      cats,
    );
    expect(m).toMatchObject({ total: 5, correct: 2, incorrect: 1, invalid: 1, missing: 1 });
    // 2 correct / 5 labelled = 40%, not 2 correct / 3 answered.
    expect(m.accuracy).toBe(0.4);
    expect(pct(m.accuracy)).toBe('40.00');
    expect(m.confusion).toEqual({
      A: { A: 2, B: 0, C: 0, INVALID: 0, MISSING: 0 },
      B: { A: 1, B: 0, C: 0, INVALID: 1, MISSING: 0 },
      C: { A: 0, B: 0, C: 0, INVALID: 0, MISSING: 1 },
    });
    expect(m.perCategory).toEqual([
      { category: 'A', cases: 2, correct: 2, recall: 1 },
      { category: 'B', cases: 2, correct: 0, recall: 0 },
      { category: 'C', cases: 1, correct: 0, recall: 0 },
    ]);
  });

  it('every labelled case lands in exactly one outcome', () => {
    const m = computeMetrics(cases, [pred('1', 'predicted', 'c1'), pred('2', 'missing')], cats);
    expect(m.correct + m.incorrect + m.invalid + m.missing).toBe(m.total);
    const cells = Object.values(m.confusion).flatMap((r) => Object.values(r));
    expect(cells.reduce((a, b) => a + b, 0)).toBe(m.total);
  });

  it('treats a "valid" prediction outside the category set as invalid, never correct', () => {
    const m = computeMetrics(cases, [pred('1', 'predicted', 'not-a-category')], cats);
    expect(m.invalid).toBe(1);
    expect(m.correct).toBe(0);
  });

  it('reports no accuracy for an empty set rather than 0 or 100', () => {
    const m = computeMetrics([], [], cats);
    expect(m).toMatchObject({ total: 0, accuracy: null, interval95: null });
    expect(pct(m.accuracy)).toBe('n/a');
  });

  it('rejects duplicate or unknown predictions and unknown reference categories', () => {
    expect(() => computeMetrics(cases, [pred('1', 'missing'), pred('1', 'missing')], cats)).toThrow(
      /Duplicate prediction/,
    );
    expect(() => computeMetrics(cases, [pred('zzz', 'missing')], cats)).toThrow(/unknown case/);
    expect(() => computeMetrics([{ id: 'x', referenceCategoryId: 'nope' }], [], cats)).toThrow(
      /unknown reference/,
    );
  });

  it('wilson95 matches known values and stays within 0..1', () => {
    const w = wilson95(39, 40)!;
    expect(w.lower).toBeCloseTo(0.8712, 3);
    expect(w.upper).toBeCloseTo(0.9956, 3);
    expect(wilson95(0, 10)!.lower).toBe(0);
    expect(wilson95(10, 10)!.upper).toBeLessThanOrEqual(1);
    expect(wilson95(0, 0)).toBeNull();
  });
});

describe('fixture reproducibility against the seeded Q07 expectations', () => {
  it('the harness definition gives the hand-calculated EXPECTED.q07 values', () => {
    const fx = buildFixtures('test');
    // First saved recommendation per ticket, exactly as SQL Q07 picks it.
    const first = new Map<string, string | null>();
    for (const r of [...fx.recommendations].sort(
      (a, b) =>
        new Date(a.createdAt as Date).getTime() - new Date(b.createdAt as Date).getTime() ||
        a.id!.localeCompare(b.id!),
    )) {
      if (!first.has(r.ticketId)) first.set(r.ticketId, r.proposedCategoryId ?? null);
    }
    const cases = fx.labels.map((l) => ({
      id: l.ticketId,
      referenceCategoryId: l.referenceCategoryId,
    }));
    const predictions = fx.labels.map((l): CasePrediction => {
      const category = first.get(l.ticketId) ?? null;
      return pred(l.ticketId, category ? 'predicted' : 'missing', category);
    });
    const m = computeMetrics(
      cases,
      predictions,
      fx.categories.map((c) => ({ id: c.id!, name: c.name })),
    );
    expect(m.total).toBe(EXPECTED.q07.labelledTickets);
    expect(m.total - m.missing).toBe(EXPECTED.q07.withRecommendation);
    expect(m.correct).toBe(EXPECTED.q07.correct);
    expect(pct(m.accuracy)).toBe(EXPECTED.q07.accuracyPct);
  });
});

describe('dataset', () => {
  it('has unique ids, valid labels and four balanced categories of synthetic text', () => {
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    const names = new Set(EVAL_CATEGORIES.map((c) => c.name));
    for (const c of EVAL_CASES) {
      expect(names.has(c.reference), c.id).toBe(true);
      expect(c.rationale.trim().length, c.id).toBeGreaterThan(0);
      expect(ALLOWED_TEAMS_BY_CATEGORY[c.reference]?.length).toBeGreaterThan(0);
      // Nothing that looks like an email, token or number sequence worth redacting.
      expect(redactText(c.title), c.id).toBe(c.title);
      expect(redactText(c.description), c.id).toBe(c.description);
    }
    for (const name of names) {
      expect(EVAL_CASES.filter((c) => c.reference === name)).toHaveLength(10);
    }
  });

  it('is pinned: changing any case or label requires a new version and hash', () => {
    expect(DATASET_VERSION).toBe('1.0.0');
    expect(datasetHash()).toBe('8e7420420cda8fe39221feaafda4f77095be2ec95d9063136650315dd0290e8a');
    const edited = EVAL_CASES.map((c, i) =>
      i === 0 ? { ...c, reference: 'Software' as const } : c,
    );
    expect(datasetHash(edited)).not.toBe(datasetHash());
  });

  it('pins the prompt text to its version', () => {
    expect(assertPromptPinned().version).toBe(PROMPT_VERSION);
    expect(Object.keys(PROMPT_HASHES)).toContain(PROMPT_VERSION);
  });
});

/** Test-only oracle: looks the answer up by title. The real harness never gives a provider labels. */
const oracle = (): AIProvider => {
  const byTitle = new Map(EVAL_CASES.map((c) => [c.title, c]));
  return {
    name: 'oracle',
    async analyse(req: AnalysisRequest) {
      const c = byTitle.get(req.ticket.title)!;
      const cat = req.allowedCategories.find((x) => x.name === c.reference)!;
      return validateProposal(
        {
          categoryId: cat.id,
          teamId: req.allowedTeams[0]!.id,
          priority: 'LOW',
          troubleshooting: 'x',
        },
        req,
        'oracle:1',
      );
    },
  };
};

describe('runEvaluation', () => {
  it('the fake provider (always the first category) scores exactly 10 of 40 = 25%', async () => {
    const run = await runEvaluation({ provider: createFakeProvider() });
    expect(run.metrics).toMatchObject({ total: 40, correct: 10, incorrect: 30, accuracy: 0.25 });
    expect(run.failures).toHaveLength(30);
    expect(run.metadata).toMatchObject({
      provider: 'fake',
      promptVersion: PROMPT_VERSION,
      datasetVersion: DATASET_VERSION,
      casesRun: 40,
      providerCalls: 40,
      modelVersions: ['fake:deterministic-v1'],
    });
  });

  it('a perfect provider scores 40 of 40, so ids and names map correctly', async () => {
    const run = await runEvaluation({ provider: oracle() });
    expect(run.metrics.correct).toBe(40);
    expect(run.metrics.accuracy).toBe(1);
    expect(run.failures).toEqual([]);
  });

  it('never gives the provider a label, rationale or case id', async () => {
    const seen: AnalysisRequest[] = [];
    const spy: AIProvider = {
      name: 'spy',
      async analyse(req) {
        seen.push(req);
        throw new ProviderError('unavailable');
      },
    };
    await runEvaluation({ provider: spy, limit: 5 });
    expect(seen).toHaveLength(5);
    for (const req of seen) {
      expect(Object.keys(req.ticket).sort()).toEqual(['description', 'title']);
      const wire = JSON.stringify(req);
      for (const c of EVAL_CASES) {
        expect(wire).not.toContain(c.rationale);
        expect(wire).not.toContain(c.id);
      }
      expect(req.articles).toEqual([]);
    }
  });

  it('counts errors, unusable answers and missing answers as wrong, over all 40', async () => {
    const good = oracle();
    let n = 0;
    const flaky: AIProvider = {
      name: 'flaky',
      async analyse(req) {
        n++;
        if (n <= 5) throw new ProviderError('timeout'); // no answer
        if (n <= 10) throw new ProviderError('malformed'); // unusable answer
        return good.analyse(req);
      },
    };
    const run = await runEvaluation({ provider: flaky });
    expect(run.metrics).toMatchObject({
      total: 40,
      correct: 30,
      incorrect: 0,
      invalid: 5,
      missing: 5,
      accuracy: 0.75,
    });
    expect(run.failures.map((f) => [f.outcome, f.errorKind])).toEqual([
      ...Array(5).fill(['missing', 'timeout']),
      ...Array(5).fill(['invalid', 'malformed']),
    ]);
    expect(run.metrics.confusion.Hardware![MISSING]).toBe(5);
  });

  it('the first valid answer within maxCalls is the prediction; one call by default', async () => {
    const make = (): AIProvider => {
      const good = oracle();
      const attempts = new Map<string, number>();
      return {
        name: 'second-try',
        async analyse(req) {
          const k = (attempts.get(req.ticket.title) ?? 0) + 1;
          attempts.set(req.ticket.title, k);
          if (k === 1) throw new ProviderError('rate_limited');
          return good.analyse(req);
        },
      };
    };
    const once = await runEvaluation({ provider: make() });
    expect(once.metrics).toMatchObject({ correct: 0, missing: 40, accuracy: 0 });
    const twice = await runEvaluation({ provider: make(), maxCalls: 2 });
    expect(twice.metrics).toMatchObject({ correct: 40, accuracy: 1 });
    expect(twice.metadata.providerCalls).toBe(80);
  });

  it('limit shrinks the denominator and the report says so', async () => {
    const run = await runEvaluation({ provider: oracle(), limit: 10 });
    expect(run.metrics.total).toBe(10);
    expect(run.metadata).toMatchObject({ casesRun: 10, datasetSize: 40 });
    expect(renderReport(run)).toContain('limited; accuracy covers only these cases');
  });

  it('is deterministic: two runs of the baseline agree on everything but timing', async () => {
    const a = await runEvaluation({ provider: createKeywordBaseline() });
    const b = await runEvaluation({ provider: createKeywordBaseline() });
    expect({ ...a, metadata: { ...a.metadata, startedAt: '', durationMs: 0 } }).toEqual({
      ...b,
      metadata: { ...b.metadata, startedAt: '', durationMs: 0 },
    });
    expect(a.metrics.total).toBe(40);
  });

  it('accepts custom cases (a tiny dataset, hand-checked)', async () => {
    const cases: EvalCase[] = EVAL_CASES.slice(0, 3).map((c) => ({ ...c }));
    const run = await runEvaluation({ provider: oracle(), cases });
    expect(run.metrics.total).toBe(3);
    expect(run.metadata.datasetSha256).toBe(datasetHash(cases));
  });
});

describe('report', () => {
  it('states the measured fraction, is plain about non-models, and never claims the target', async () => {
    const run = await runEvaluation({ provider: createFakeProvider() });
    const text = renderReport(run);
    expect(text).toContain('10 of 40 labelled cases = 25.00%');
    expect(text).toContain('not an AI model');
    expect(text).toContain('says nothing about the 90% target');
    expect(text).not.toMatch(/target (is |was )?met|meets the target|achieves/i);
    expect(text).toContain(run.metadata.datasetSha256);
    expect(text).toContain(run.metadata.promptSha256);
    expect(text).toContain('| EV-011 |'); // a failed case is traceable
  });

  it('for a live-style provider quotes the target as a goal and checks the interval bound', async () => {
    const live = { ...oracle(), name: 'openai' } as AIProvider;
    const perfect = renderReport(await runEvaluation({ provider: live }));
    expect(perfect).toContain('40 of 40 labelled cases = 100.00%');
    expect(perfect).toContain('a goal, not a result');
    expect(perfect).toContain('a point estimate alone does not establish the target');

    // 39 of 40 = 97.5%: the point estimate clears 90% but the interval's lower bound (about 87%) does not.
    let n = 0;
    const good = oracle();
    const oneWrong: AIProvider = {
      name: 'openai',
      async analyse(req) {
        if (++n === 1) throw new ProviderError('malformed');
        return good.analyse(req);
      },
    };
    const text = renderReport(await runEvaluation({ provider: oneWrong }));
    expect(text).toContain('39 of 40 labelled cases = 97.50%');
    expect(text).toContain('Point estimate is at or above the target');
    expect(text).toContain('lower bound of the interval is below it');
  });

  it('reports an empty run without inventing a number', async () => {
    const text = renderReport(await runEvaluation({ provider: oracle(), limit: 0 }));
    expect(text).toContain('no accuracy to report');
    expect(text).not.toMatch(/= \d/);
  });
});
