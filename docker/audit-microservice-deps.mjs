import { spawnSync } from 'node:child_process';

const packages = [
  'frontend',
  'backend',
  'backend/gateway',
  'backend/services/ai',
  'backend/services/analytics',
  'backend/services/identity',
  'backend/services/knowledge',
  'backend/services/notifications',
  'packages/ai-analysis',
  'packages/analytics',
  'packages/contracts',
  'packages/db',
  'packages/identity',
  'packages/knowledge',
  'packages/notifications',
  'packages/service-runtime',
];
const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim();
const results = {};
for (const project of packages) {
  const audit = spawnSync('npm', ['audit', '--package-lock-only', '--json'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
  });
  try {
    const report = JSON.parse(audit.stdout);
    if (report.error || !report.metadata) {
      results[project] = { error: report.error?.code ?? 'missing-report' };
      process.exitCode = 1;
    } else {
      results[project] = report;
    }
  } catch {
    results[project] = { error: audit.error?.code ?? 'invalid-report' };
    process.exitCode = 1;
  }
}
console.log(JSON.stringify({ node: process.version, npm, results }, null, 2));
