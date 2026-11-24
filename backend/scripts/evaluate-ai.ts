/**
 * Evaluate AI category classification against the version-controlled labelled dataset (SD-039).
 *
 *   npm run eval:ai -- --provider baseline --out-md report.md --out-json run.json
 *
 * Providers:
 *   baseline    deterministic keyword rules; not an AI model (default, used by CI)
 *   fake        the deterministic fake provider (always proposes the first category)
 *   configured  the provider chosen by AI_PROVIDER / AI_API_KEY / AI_MODEL, for example openai.
 *               It sends the synthetic tickets to that service and costs money, so it also needs
 *               EVAL_ALLOW_LIVE=1.
 *
 * Options: --max-calls N (calls per case until one is valid, default 1), --limit N (first N cases),
 * --out-md PATH, --out-json PATH. Exit code is 0 whatever the accuracy: this reports, it does not gate.
 */
import { writeFileSync } from 'node:fs';
import { createFakeProvider, type AIProvider } from '@smartdesk/ai-analysis';
import { loadEnv } from '../src/config/env.js';
import { createProvider } from '../src/modules/ai/index.js';
import { createKeywordBaseline } from '../src/modules/ai/evaluation/baseline.js';
import { renderReport } from '../src/modules/ai/evaluation/report.js';
import { runEvaluation } from '../src/modules/ai/evaluation/run.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function positive(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
  return n;
}

const which = arg('provider') ?? 'baseline';
let provider: AIProvider;
if (which === 'baseline') {
  provider = createKeywordBaseline();
} else if (which === 'fake') {
  provider = createFakeProvider();
} else if (which === 'configured') {
  if (process.env.EVAL_ALLOW_LIVE !== '1') {
    console.error('Refusing to call a live provider: set EVAL_ALLOW_LIVE=1 to confirm the cost.');
    process.exit(2);
  }
  provider = createProvider(loadEnv());
} else {
  console.error(`Unknown --provider "${which}" (baseline, fake or configured)`);
  process.exit(2);
}

const maxCalls = positive('max-calls');
const limit = positive('limit');
const run = await runEvaluation({
  provider,
  ...(maxCalls ? { maxCalls } : {}),
  ...(limit ? { limit } : {}),
  gitSha: process.env.GIT_SHA ?? null,
});

const report = renderReport(run);
const outMd = arg('out-md');
const outJson = arg('out-json');
if (outMd) writeFileSync(outMd, report, 'utf8');
if (outJson) writeFileSync(outJson, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
if (!outMd) console.log(report);
else console.log(`Wrote ${outMd}${outJson ? ` and ${outJson}` : ''}`);
