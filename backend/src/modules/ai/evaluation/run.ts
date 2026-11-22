import { createHash } from 'node:crypto';
import { PROMPT_VERSION, SYSTEM_INSTRUCTIONS } from '../prompt.js';
import { ProviderError, type AIProvider, type AnalysisRequest } from '../provider.js';
import { redactText } from '../redact.js';
import {
  ALLOWED_TEAMS_BY_CATEGORY,
  DATASET_VERSION,
  EVAL_CASES,
  EVAL_CATEGORIES,
  EVAL_TEAMS,
  categoryByName,
  datasetHash,
  type EvalCase,
} from './dataset.js';
import { computeMetrics, type CasePrediction, type Metrics } from './metrics.js';

/**
 * SHA-256 of `SYSTEM_INSTRUCTIONS` for every released `PROMPT_VERSION`. Editing the instructions
 * without bumping the version (and adding the new hash here) fails `assertPromptPinned`, so a report's
 * "prompt version" always identifies exactly one text.
 */
export const PROMPT_HASHES: Readonly<Record<string, string>> = {
  v2: '14ff8f06d3829494c219f35b03607905ff9196d4c1611d8a5964961856ed80db',
};

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function assertPromptPinned(): { version: string; sha256: string } {
  const actual = sha256(SYSTEM_INSTRUCTIONS);
  const pinned = PROMPT_HASHES[PROMPT_VERSION];
  if (pinned !== actual) {
    throw new Error(
      `Prompt ${PROMPT_VERSION} changed (sha256 ${actual}). Bump PROMPT_VERSION and add its hash to PROMPT_HASHES.`,
    );
  }
  return { version: PROMPT_VERSION, sha256: actual };
}

export interface CaseResult extends CasePrediction {
  referenceCategory: string;
  predictedCategory: string | null;
  /** True when the predicted team is one the dataset accepts for the reference category. */
  teamAllowed: boolean | null;
  calls: number;
}

export interface EvaluationRun {
  metadata: {
    startedAt: string;
    durationMs: number;
    provider: string;
    /** Model versions the provider reported (empty if it never produced a valid answer). */
    modelVersions: string[];
    promptVersion: string;
    promptSha256: string;
    datasetVersion: string;
    datasetSha256: string;
    maxCallsPerCase: number;
    casesRun: number;
    datasetSize: number;
    providerCalls: number;
    /** Characters of ticket text sent: a rough size input for estimating cost. */
    approxInputChars: number;
    gitSha: string | null;
    node: string;
  };
  metrics: Metrics;
  /** Teams: valid predictions whose team the dataset accepts / all valid predictions. */
  teamCheck: { allowed: number; predicted: number };
  results: CaseResult[];
  /** Everything that is not a correct first valid prediction, for tracing. */
  failures: CaseResult[];
}

export interface RunOptions {
  provider: AIProvider;
  cases?: readonly EvalCase[];
  /** Calls per case until one gives a valid answer. Default 1: the first answer is the prediction. */
  maxCalls?: number;
  /** Evaluate only the first N cases (cost control). The denominator is then N. */
  limit?: number;
  gitSha?: string | null;
  now?: () => number;
}

const requestFor = (c: EvalCase): AnalysisRequest => ({
  // Only the ticket text is sent; the reference label and rationale never leave the dataset.
  ticket: { title: redactText(c.title), description: redactText(c.description) },
  allowedCategories: EVAL_CATEGORIES.map((x) => ({ id: x.id, name: x.name })),
  allowedTeams: EVAL_TEAMS.map((x) => ({ id: x.id, name: x.name })),
  articles: [],
});

/**
 * Run the provider over the labelled cases, one case at a time (kind to rate limits), and score it.
 * A case's prediction is the first valid answer within `maxCalls`; otherwise it is `invalid` (the model
 * answered but unusably) or `missing` (no usable answer at all). Both count as wrong.
 */
export async function runEvaluation(opts: RunOptions): Promise<EvaluationRun> {
  const now = opts.now ?? (() => performance.now());
  const prompt = assertPromptPinned();
  const all = opts.cases ?? EVAL_CASES;
  const cases = opts.limit === undefined ? all : all.slice(0, Math.max(0, opts.limit));
  const maxCalls = opts.maxCalls ?? 1;
  const started = new Date();
  const t0 = now();

  const catName = new Map(EVAL_CATEGORIES.map((x) => [x.id, x.name]));
  const teamName = new Map(EVAL_TEAMS.map((x) => [x.id, x.name]));
  const versions = new Set<string>();
  const results: CaseResult[] = [];
  let providerCalls = 0;
  let inputChars = 0;

  for (const c of cases) {
    const request = requestFor(c);
    inputChars += request.ticket.title.length + request.ticket.description.length;
    let calls = 0;
    let result: CaseResult | null = null;
    let lastKind: string = 'unknown';
    while (calls < maxCalls && !result) {
      calls++;
      providerCalls++;
      try {
        const p = await opts.provider.analyse(request);
        versions.add(p.modelVersion);
        const allowed = ALLOWED_TEAMS_BY_CATEGORY[c.reference] ?? [];
        result = {
          caseId: c.id,
          outcome: 'predicted',
          predictedCategoryId: p.categoryId,
          errorKind: null,
          referenceCategory: c.reference,
          predictedCategory: catName.get(p.categoryId) ?? null,
          teamAllowed: allowed.includes(teamName.get(p.teamId) ?? ''),
          calls,
        };
      } catch (err) {
        lastKind = err instanceof ProviderError ? err.kind : 'internal';
      }
    }
    results.push(
      result ?? {
        caseId: c.id,
        outcome:
          lastKind === 'malformed' || lastKind === 'invalid_reference' ? 'invalid' : 'missing',
        predictedCategoryId: null,
        errorKind: lastKind,
        referenceCategory: c.reference,
        predictedCategory: null,
        teamAllowed: null,
        calls,
      },
    );
  }

  const metrics = computeMetrics(
    cases.map((c) => ({ id: c.id, referenceCategoryId: categoryByName(c.reference).id })),
    results,
    EVAL_CATEGORIES,
  );
  const predicted = results.filter((r) => r.outcome === 'predicted');
  return {
    metadata: {
      startedAt: started.toISOString(),
      durationMs: Math.round(now() - t0),
      provider: opts.provider.name,
      modelVersions: [...versions].sort(),
      promptVersion: prompt.version,
      promptSha256: prompt.sha256,
      datasetVersion: DATASET_VERSION,
      datasetSha256: datasetHash(all),
      maxCallsPerCase: maxCalls,
      casesRun: cases.length,
      datasetSize: all.length,
      providerCalls,
      approxInputChars: inputChars,
      gitSha: opts.gitSha ?? null,
      node: process.version,
    },
    metrics,
    teamCheck: {
      allowed: predicted.filter((r) => r.teamAllowed).length,
      predicted: predicted.length,
    },
    results,
    failures: results.filter((r) => r.predictedCategory !== r.referenceCategory),
  };
}
