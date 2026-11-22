import { INVALID, MISSING, pct } from './metrics.js';
import type { EvaluationRun } from './run.js';

/** Providers whose score says nothing about a real model. */
const NOT_A_MODEL = new Set(['fake', 'baseline', 'none']);

const TARGET = 0.9;

/**
 * Markdown report. It states what was measured and nothing more: the target is quoted as a goal,
 * never as a result, and a score from the fake or baseline provider is labelled as exercising the
 * harness only.
 */
export function renderReport(run: EvaluationRun): string {
  const { metadata: m, metrics: x } = run;
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);

  add('# AI category classification: evaluation report', '');
  add(
    `Provider \`${m.provider}\`${m.modelVersions.length ? ` (${m.modelVersions.map((v) => `\`${v}\``).join(', ')})` : ''}, ` +
      `prompt \`${m.promptVersion}\`, dataset \`${m.datasetVersion}\`.`,
    '',
  );

  add('## Result', '');
  if (x.total === 0) {
    add('No cases were run, so there is no accuracy to report.', '');
  } else {
    add(
      `**Category accuracy: ${x.correct} of ${x.total} labelled cases = ${pct(x.accuracy)}%** ` +
        `(95% interval ${pct(x.interval95?.lower ?? null)}% to ${pct(x.interval95?.upper ?? null)}%).`,
      '',
      'Accuracy is correct first valid predictions divided by **all** labelled cases. A case with no ' +
        'valid prediction counts as wrong and stays in the denominator.',
      '',
      '| Outcome | Cases |',
      '| --- | ---: |',
      `| Correct | ${x.correct} |`,
      `| Wrong category | ${x.incorrect} |`,
      `| Invalid answer | ${x.invalid} |`,
      `| No answer (missing) | ${x.missing} |`,
      `| **Total labelled** | **${x.total}** |`,
      '',
    );
    const target = `${TARGET * 100}%`;
    if (NOT_A_MODEL.has(m.provider)) {
      add(
        `This run used the \`${m.provider}\` provider, which is not an AI model (its rules were written with ` +
          `this dataset in view, so its score is optimistic). The number only shows the harness works; it ` +
          `says nothing about the ${target} target for a real model.`,
        '',
      );
    } else {
      const lower = x.interval95?.lower ?? 0;
      add(
        `Target for reference: at least ${target} (a goal, not a result). ` +
          `Point estimate ${(x.accuracy ?? 0) >= TARGET ? 'is at or above' : 'is below'} the target; ` +
          `lower bound of the interval ${lower >= TARGET ? 'is at or above' : 'is below'} it. ` +
          `With ${x.total} cases the interval is wide, so a point estimate alone does not establish the target.`,
        '',
      );
    }
  }

  add(
    '## Per category',
    '',
    '| Reference category | Cases | Correct | Recall |',
    '| --- | ---: | ---: | ---: |',
  );
  for (const c of x.perCategory)
    add(`| ${c.category} | ${c.cases} | ${c.correct} | ${pct(c.recall)}% |`);
  add('');

  const cols = [...Object.keys(x.confusion), INVALID, MISSING];
  add(
    '## Confusion matrix',
    '',
    'Rows are the reference category, columns what was predicted.',
    '',
    `| Reference \\ Predicted | ${cols.join(' | ')} |`,
    `| --- | ${cols.map(() => '---:').join(' | ')} |`,
  );
  for (const [ref, row] of Object.entries(x.confusion)) {
    add(`| ${ref} | ${cols.map((c) => row[c] ?? 0).join(' | ')} |`);
  }
  add('');

  if (run.teamCheck.predicted > 0) {
    add(
      '## Team (secondary check)',
      '',
      `${run.teamCheck.allowed} of ${run.teamCheck.predicted} valid predictions named a team the dataset accepts for the reference category. This is not part of the accuracy figure.`,
      '',
    );
  }

  add('## Failed predictions', '');
  if (run.failures.length === 0) {
    add('None.', '');
  } else {
    add('| Case | Reference | Outcome | Predicted / reason |', '| --- | --- | --- | --- |');
    for (const f of run.failures) {
      add(
        `| ${f.caseId} | ${f.referenceCategory} | ${f.outcome === 'predicted' ? 'wrong category' : f.outcome} | ${f.predictedCategory ?? f.errorKind ?? ''} |`,
      );
    }
    add('');
  }

  add(
    '## Run details',
    '',
    `- Started ${m.startedAt}, ${m.durationMs} ms, Node ${m.node}${m.gitSha ? `, commit ${m.gitSha}` : ''}`,
    `- Cases run: ${m.casesRun} of ${m.datasetSize}${m.casesRun < m.datasetSize ? ' (limited; accuracy covers only these cases)' : ''}`,
    `- Provider calls: ${m.providerCalls} (up to ${m.maxCallsPerCase} per case); about ${m.approxInputChars} characters of ticket text sent, as a rough size input for estimating cost with the provider's current prices`,
    `- Prompt sha256 \`${m.promptSha256}\``,
    `- Dataset sha256 \`${m.datasetSha256}\``,
    '',
    '## Limits',
    '',
    `- ${m.datasetSize} synthetic tickets, balanced across the four categories. Real tickets are messier, so results will not transfer automatically.`,
    '- The evaluator who wrote the labels is the same team that built the system; a second labeller would reduce that bias.',
    '- Only the category is scored. Priority and troubleshooting quality are not measured here.',
    '- Retrieval is off (no articles are supplied), so this measures classification from the ticket text alone.',
    '- Live results depend on the model, its version and the prompt at run time; rerun to compare.',
    '',
    '## How this relates to SQL report Q07',
    '',
    'Q07 uses the same definition on real labelled tickets in the database (first saved recommendation, missing counts as wrong, denominator is all labelled tickets). This offline harness measures a fixed synthetic dataset; Q07 measures production. They are comparable in method, not in data.',
    '',
  );
  return lines.join('\n');
}
