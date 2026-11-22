/**
 * Manual-versus-SmartDesk routing comparison (SD-047). Pure functions only: they take captured
 * observations and compute the figures, so an independent reviewer can recompute every number from
 * the same files.
 *
 * One observation is one ticket's routing time: from `startedAt` (ticket submission) to
 * `assignedAt` (the first approved support-team assignment). A blank `assignedAt` means the ticket
 * was never routed in the observation period; it is counted and disclosed, never dropped silently
 * and never given a made-up duration.
 */

export const TARGET_REDUCTION_PCT = 50;
export const DEFAULT_MIN_SAMPLE = 10;
/** A category whose share differs by more than this many percentage points is flagged. */
export const MIX_WARNING_POINTS = 20;

export const CSV_HEADER = ['observation_id', 'category', 'started_at', 'assigned_at', 'note'];

export interface Observation {
  id: string;
  category: string;
  startedAt: Date;
  /** null: not routed during the observation period. */
  assignedAt: Date | null;
  note: string;
}

export interface ParsedObservations {
  observations: Observation[];
  /** Rows that could not be used, with the reason. They are reported, not hidden. */
  invalid: { line: number; id: string; reason: string }[];
}

/** Split one CSV line, honouring double quotes ("" is an escaped quote). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function instant(value: string): Date | null {
  if (!ISO_WITH_OFFSET.test(value)) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse the observation CSV (header `observation_id,category,started_at,assigned_at,note`). */
export function parseObservations(csv: string): ParsedObservations {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv; // drop a byte-order mark
  const lines = text.split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '');
  if (CSV_HEADER.some((h, i) => header[i] !== h)) {
    throw new Error(`Header must be: ${CSV_HEADER.join(',')}`);
  }
  const observations: Observation[] = [];
  const invalid: ParsedObservations['invalid'] = [];
  const seen = new Set<string>();
  lines.slice(1).forEach((raw, index) => {
    const line = index + 2;
    if (!raw.trim() || raw.trimStart().startsWith('#')) return;
    const [id = '', category = '', started = '', assigned = '', note = ''] = splitCsvLine(raw);
    const bad = (reason: string) => invalid.push({ line, id, reason });
    if (!id) return bad('missing observation_id');
    if (seen.has(id)) throw new Error(`Duplicate observation_id "${id}" on line ${line}`);
    seen.add(id);
    if (!category) return bad('missing category');
    const startedAt = instant(started);
    if (!startedAt) return bad('started_at must be an ISO-8601 time with an offset');
    let assignedAt: Date | null = null;
    if (assigned) {
      assignedAt = instant(assigned);
      if (!assignedAt) return bad('assigned_at must be blank or an ISO-8601 time with an offset');
      if (assignedAt.getTime() < startedAt.getTime())
        return bad('assigned_at is before started_at');
    }
    observations.push({ id, category, startedAt, assignedAt, note });
  });
  return { observations, invalid };
}

export interface Stats {
  n: number;
  meanMinutes: number | null;
  medianMinutes: number | null;
  /** Sample standard deviation (n - 1); null below two observations. */
  sdMinutes: number | null;
  minMinutes: number | null;
  maxMinutes: number | null;
}

export const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export function minutesBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 60_000;
}

export function stats(minutes: number[]): Stats {
  const n = minutes.length;
  if (n === 0) {
    return {
      n,
      meanMinutes: null,
      medianMinutes: null,
      sdMinutes: null,
      minMinutes: null,
      maxMinutes: null,
    };
  }
  const sorted = [...minutes].sort((a, b) => a - b);
  const mean = minutes.reduce((a, b) => a + b, 0) / n;
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const sd = n < 2 ? null : Math.sqrt(minutes.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return {
    n,
    meanMinutes: round2(mean),
    medianMinutes: round2(median),
    sdMinutes: sd === null ? null : round2(sd),
    minMinutes: round2(sorted[0]!),
    maxMinutes: round2(sorted[n - 1]!),
  };
}

export type Verdict = 'MET' | 'NOT_MET' | 'INCONCLUSIVE';

export interface CohortSummary extends Stats {
  label: string;
  /** Observations supplied (valid rows). */
  observed: number;
  /** Observed but never routed; excluded from the mean and disclosed. */
  unrouted: number;
  /** Rows rejected as unusable. */
  invalid: number;
}

export interface BaselineReport {
  manual: CohortSummary;
  assisted: CohortSummary;
  /** `(manualMean - assistedMean) / manualMean * 100`; null when undefined (no data, zero manual mean). */
  improvementPct: number | null;
  targetPct: number;
  minSample: number;
  verdict: Verdict;
  /** Why the verdict is what it is, in words, including every reason it is not a claim. */
  verdictReason: string;
  categoryMix: {
    category: string;
    manual: number;
    assisted: number;
    manualSharePct: number | null;
    assistedSharePct: number | null;
  }[];
  /** Comparability problems found (empty means none were detected, not that the cohorts match). */
  comparabilityWarnings: string[];
}

function summarize(label: string, parsed: ParsedObservations): [CohortSummary, Observation[]] {
  const routed = parsed.observations.filter((o) => o.assignedAt);
  const s = stats(routed.map((o) => minutesBetween(o.startedAt, o.assignedAt!)));
  return [
    {
      label,
      ...s,
      observed: parsed.observations.length,
      unrouted: parsed.observations.length - routed.length,
      invalid: parsed.invalid.length,
    },
    routed,
  ];
}

/** Improvement in percent, or null when it is undefined. Not rounded. */
export function improvement(manualMean: number | null, assistedMean: number | null): number | null {
  if (manualMean === null || assistedMean === null || manualMean <= 0) return null;
  return ((manualMean - assistedMean) / manualMean) * 100;
}

export function compare(
  manual: ParsedObservations,
  assisted: ParsedObservations,
  opts: { minSample?: number; targetPct?: number } = {},
): BaselineReport {
  const minSample = opts.minSample ?? DEFAULT_MIN_SAMPLE;
  const targetPct = opts.targetPct ?? TARGET_REDUCTION_PCT;
  const [m, mRouted] = summarize('Manual triage', manual);
  const [a, aRouted] = summarize('SmartDesk-assisted', assisted);

  // Improvement is computed from the unrounded means so rounding cannot move the verdict.
  const rawMean = (obs: Observation[]) =>
    obs.length === 0
      ? null
      : obs.reduce((t, o) => t + minutesBetween(o.startedAt, o.assignedAt!), 0) / obs.length;
  const raw = improvement(rawMean(mRouted), rawMean(aRouted));

  let verdict: Verdict;
  let verdictReason: string;
  if (raw === null) {
    verdict = 'INCONCLUSIVE';
    verdictReason =
      'The improvement is undefined: a cohort has no routed observations or the manual mean is not positive.';
  } else if (m.n < minSample || a.n < minSample) {
    verdict = 'INCONCLUSIVE';
    verdictReason = `Fewer than ${minSample} routed observations in a cohort (manual ${m.n}, assisted ${a.n}), so no claim is made either way.`;
  } else if (raw >= targetPct) {
    verdict = 'MET';
    verdictReason = `The measured reduction is at or above ${targetPct}% on these samples. See the limitations before generalising.`;
  } else {
    verdict = 'NOT_MET';
    verdictReason = `The measured reduction is below ${targetPct}% on these samples.`;
  }

  const categories = [...new Set([...mRouted, ...aRouted].map((o) => o.category))].sort((x, y) =>
    x.localeCompare(y),
  );
  const share = (count: number, total: number) => (total ? round2((count / total) * 100) : null);
  const categoryMix = categories.map((category) => {
    const mc = mRouted.filter((o) => o.category === category).length;
    const ac = aRouted.filter((o) => o.category === category).length;
    return {
      category,
      manual: mc,
      assisted: ac,
      manualSharePct: share(mc, mRouted.length),
      assistedSharePct: share(ac, aRouted.length),
    };
  });
  const comparabilityWarnings: string[] = [];
  for (const row of categoryMix) {
    if (row.manual === 0 || row.assisted === 0) {
      comparabilityWarnings.push(
        `${row.category} appears in only one cohort (manual ${row.manual}, assisted ${row.assisted}).`,
      );
    } else if (
      Math.abs((row.manualSharePct ?? 0) - (row.assistedSharePct ?? 0)) > MIX_WARNING_POINTS
    ) {
      comparabilityWarnings.push(
        `${row.category} is ${row.manualSharePct}% of manual but ${row.assistedSharePct}% of assisted observations.`,
      );
    }
  }

  return {
    manual: m,
    assisted: a,
    improvementPct: raw === null ? null : round2(raw),
    targetPct,
    minSample,
    verdict,
    verdictReason,
    categoryMix,
    comparabilityWarnings,
  };
}

const fmt = (v: number | null, unit = '') => (v === null ? 'N/A' : `${v}${unit}`);

function cohortRow(c: CohortSummary): string {
  return `| ${c.label} | ${c.observed} | ${c.n} | ${c.unrouted} | ${c.invalid} | ${fmt(c.meanMinutes)} | ${fmt(c.medianMinutes)} | ${fmt(c.sdMinutes)} | ${fmt(c.minMinutes)} | ${fmt(c.maxMinutes)} |`;
}

/** Markdown report for a run, with every input to the headline number shown. */
export function renderReport(
  r: BaselineReport,
  meta: { manualFile: string; assistedFile: string; generatedAt: string },
): string {
  const lines = [
    '# Routing time: manual versus SmartDesk-assisted',
    '',
    `Generated ${meta.generatedAt} from \`${meta.manualFile}\` and \`${meta.assistedFile}\`.`,
    '',
    '## Result',
    '',
    `- **Verdict against the ${r.targetPct}% target: ${r.verdict.replace('_', ' ')}.** ${r.verdictReason}`,
    `- Manual mean: ${fmt(r.manual.meanMinutes, ' min')} (n = ${r.manual.n})`,
    `- SmartDesk-assisted mean: ${fmt(r.assisted.meanMinutes, ' min')} (n = ${r.assisted.n})`,
    `- Improvement = (manual mean − assisted mean) / manual mean × 100 = **${fmt(r.improvementPct, '%')}**`,
    '',
    '## Samples, exclusions and spread (minutes from submission to first approved team assignment)',
    '',
    '| Cohort | Observed | Routed (in mean) | Unrouted (excluded) | Invalid rows | Mean | Median | SD | Min | Max |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    cohortRow(r.manual),
    cohortRow(r.assisted),
    '',
    '## Category mix of routed observations',
    '',
    '| Category | Manual | Assisted | Manual share | Assisted share |',
    '| --- | --- | --- | --- | --- |',
    ...r.categoryMix.map(
      (c) =>
        `| ${c.category} | ${c.manual} | ${c.assisted} | ${fmt(c.manualSharePct, '%')} | ${fmt(c.assistedSharePct, '%')} |`,
    ),
    '',
    '## Comparability',
    '',
    ...(r.comparabilityWarnings.length
      ? r.comparabilityWarnings.map((w) => `- Warning: ${w}`)
      : [
          '- No category-mix differences above the warning threshold were detected. This does not prove the cohorts are otherwise comparable.',
        ]),
    '',
    '## Limits',
    '',
    `- Fewer than ${r.minSample} routed observations in either cohort gives an inconclusive verdict.`,
    '- Means are over routed tickets only; unrouted tickets are disclosed above, not counted as zero or as the maximum.',
    '- The two cohorts are not randomised. Differences in ticket mix, workload, time of day and who performed the manual triage can move the result.',
    '- A single mean hides spread; the median, SD, min and max are shown for that reason.',
    '',
  ];
  return lines.join('\n');
}
