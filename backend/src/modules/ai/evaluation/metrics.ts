/**
 * Category-accuracy maths for the evaluation harness. Pure functions, no I/O.
 *
 * Definition (the same as SQL report Q07, so offline and production numbers are comparable):
 *   accuracy = correct first valid predictions / ALL independently labelled cases.
 * A case with no valid prediction (provider error, unusable answer, no answer) is WRONG and stays in
 * the denominator. Accuracy is never computed over only the answered cases.
 */

export type PredictionOutcome = 'predicted' | 'invalid' | 'missing';

export interface LabelledCase {
  id: string;
  /** Reference category id, from the independent labels. */
  referenceCategoryId: string;
}

export interface CasePrediction {
  caseId: string;
  /** `predicted`: a valid proposal. `invalid`: answered but unusable. `missing`: no answer at all. */
  outcome: PredictionOutcome;
  predictedCategoryId: string | null;
  /** Provider error kind for `invalid` and `missing`. */
  errorKind: string | null;
}

export interface CategoryName {
  id: string;
  name: string;
}

export const INVALID = 'INVALID';
export const MISSING = 'MISSING';

export interface Interval {
  lower: number;
  upper: number;
}

export interface Metrics {
  /** All independently labelled cases: the accuracy denominator. */
  total: number;
  correct: number;
  /** Valid prediction, wrong category. */
  incorrect: number;
  invalid: number;
  missing: number;
  /** correct / total as a fraction, or null when there are no cases. */
  accuracy: number | null;
  /** 95% Wilson score interval for `accuracy`: the plausible range given the sample size. */
  interval95: Interval | null;
  /** rows: reference category; columns: predicted category, INVALID or MISSING. */
  confusion: Record<string, Record<string, number>>;
  perCategory: { category: string; cases: number; correct: number; recall: number | null }[];
}

/** 95% Wilson score interval for a proportion of `k` successes in `n` trials. */
export function wilson95(k: number, n: number): Interval | null {
  if (n <= 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

export function computeMetrics(
  cases: readonly LabelledCase[],
  predictions: readonly CasePrediction[],
  categories: readonly CategoryName[],
): Metrics {
  const nameOf = new Map(categories.map((x) => [x.id, x.name]));
  const byCase = new Map<string, CasePrediction>();
  for (const p of predictions) {
    if (byCase.has(p.caseId)) throw new Error(`Duplicate prediction for case ${p.caseId}`);
    byCase.set(p.caseId, p);
  }
  const known = new Set(cases.map((x) => x.id));
  if (known.size !== cases.length) throw new Error('Duplicate case ids in the labelled set');
  for (const id of byCase.keys()) {
    if (!known.has(id)) throw new Error(`Prediction for unknown case ${id}`);
  }

  const columns = [...categories.map((x) => x.name), INVALID, MISSING];
  const confusion: Metrics['confusion'] = {};
  for (const cat of categories) {
    confusion[cat.name] = Object.fromEntries(columns.map((col) => [col, 0]));
  }
  const refStats = new Map(categories.map((x) => [x.id, { cases: 0, correct: 0 }]));

  let correct = 0;
  let incorrect = 0;
  let invalid = 0;
  let missing = 0;
  for (const c of cases) {
    const refName = nameOf.get(c.referenceCategoryId);
    if (!refName) throw new Error(`Case ${c.id} has an unknown reference category`);
    const stats = refStats.get(c.referenceCategoryId)!;
    stats.cases++;
    const p = byCase.get(c.id);
    // No prediction at all is treated exactly like a missing one.
    const outcome: PredictionOutcome = p?.outcome ?? 'missing';
    let column: string;
    if (outcome === 'predicted') {
      const predictedName = p?.predictedCategoryId ? nameOf.get(p.predictedCategoryId) : undefined;
      if (!predictedName) {
        // A "valid" prediction naming a category outside the evaluation set cannot be correct.
        invalid++;
        column = INVALID;
      } else if (p!.predictedCategoryId === c.referenceCategoryId) {
        correct++;
        stats.correct++;
        column = predictedName;
      } else {
        incorrect++;
        column = predictedName;
      }
    } else if (outcome === 'invalid') {
      invalid++;
      column = INVALID;
    } else {
      missing++;
      column = MISSING;
    }
    confusion[refName]![column]!++;
  }

  const total = cases.length;
  return {
    total,
    correct,
    incorrect,
    invalid,
    missing,
    accuracy: total === 0 ? null : correct / total,
    interval95: wilson95(correct, total),
    confusion,
    perCategory: categories.map((cat) => {
      const s = refStats.get(cat.id)!;
      return {
        category: cat.name,
        cases: s.cases,
        correct: s.correct,
        recall: s.cases === 0 ? null : s.correct / s.cases,
      };
    }),
  };
}

/** "40.00" style percentage with two decimals, or "n/a". */
export const pct = (x: number | null): string => (x === null ? 'n/a' : (x * 100).toFixed(2));
