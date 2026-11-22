/**
 * Manual-versus-SmartDesk routing baseline (SD-047). See docs/testing/routing-baseline.md.
 *
 *   # 1. Export the assisted cohort's raw observations from the database (read-only):
 *   npm run baseline:routing -- export-assisted --start 2026-03-01 --end 2026-04-01 \
 *     --out assisted.csv [--ai-assisted-only]
 *
 *   # 2. Compute the comparison from two observation files (no database needed):
 *   npm run baseline:routing -- report --manual manual.csv --assisted assisted.csv \
 *     [--min-sample 10] [--target 50] [--out-md report.md] [--out-json report.json]
 *
 * `export-assisted` needs DATABASE_URL. `--start`/`--end` are UTC (a bare date is midnight UTC) and the
 * window is half-open. The command reports; it never edits data and exits 0 whatever the verdict.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrisma } from '@smartdesk/db';
import { exportAssistedObservations } from '../src/modules/baseline/export.js';
import {
  compare,
  DEFAULT_MIN_SAMPLE,
  parseObservations,
  renderReport,
  TARGET_REDUCTION_PCT,
} from '../src/modules/baseline/routingBaseline.js';

const args = process.argv.slice(2);
const command = args[0];

function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
const flag = (name: string) => args.includes(`--${name}`);
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const required = (name: string) => arg(name) ?? fail(`--${name} is required`);

function utc(name: string): Date {
  const raw = required(name);
  const d = new Date(/T/.test(raw) ? raw : `${raw}T00:00:00Z`);
  if (isNaN(d.getTime())) fail(`--${name} is not a valid date`);
  if (/T/.test(raw) && !/(Z|[+-]\d{2}:\d{2})$/.test(raw)) fail(`--${name} needs a UTC offset`);
  return d;
}

function positive(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!(n > 0)) fail(`--${name} must be a positive number`);
  return n;
}

async function main() {
  if (command === 'export-assisted') {
    const url = process.env.DATABASE_URL ?? fail('DATABASE_URL is required');
    const prisma = createPrisma(url);
    try {
      const { csv, rows } = await exportAssistedObservations(
        prisma,
        { start: utc('start'), end: utc('end') },
        { aiAssistedOnly: flag('ai-assisted-only') },
      );
      writeFileSync(required('out'), csv);
      console.log(`Wrote ${rows} observation(s) to ${arg('out')}`);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  if (command === 'report') {
    const manualFile = required('manual');
    const assistedFile = required('assisted');
    const report = compare(
      parseObservations(readFileSync(manualFile, 'utf8')),
      parseObservations(readFileSync(assistedFile, 'utf8')),
      {
        minSample: positive('min-sample', DEFAULT_MIN_SAMPLE),
        targetPct: positive('target', TARGET_REDUCTION_PCT),
      },
    );
    const markdown = renderReport(report, {
      manualFile,
      assistedFile,
      generatedAt: new Date().toISOString(),
    });
    console.log(markdown);
    const md = arg('out-md');
    if (md) writeFileSync(md, markdown);
    const json = arg('out-json');
    if (json) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  fail('Usage: baseline:routing <export-assisted|report> [options] (see the header of this file)');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
