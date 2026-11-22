// Fails when the browser bundle contains anything that must stay on the server.
// Run after `next build`: scans every emitted client script in .next/static.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../.next/static', import.meta.url));
const FORBIDDEN = [
  ['@prisma/client', 'Prisma client'],
  ['PrismaClient', 'Prisma client'],
  ['@smartdesk/db', 'database package'],
  ['DATABASE_URL', 'database credential name'],
  ['JWT_SECRET', 'token signing secret name'],
  ['SMTP_PASSWORD', 'mail credential name'],
  ['GMAIL_', 'mail credential name'],
  ['OPENAI_API_KEY', 'AI provider credential name'],
  ['ANTHROPIC_API_KEY', 'AI provider credential name'],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith('.js')) yield path;
  }
}

const hits = [];
let scanned = 0;
for (const file of walk(root)) {
  scanned += 1;
  const text = readFileSync(file, 'utf8');
  for (const [needle, what] of FORBIDDEN) {
    if (text.includes(needle)) hits.push(`${file}: ${needle} (${what})`);
  }
}

if (scanned === 0) {
  console.error('check-bundle: no client assets found; run `next build` first');
  process.exit(1);
}
if (hits.length > 0) {
  console.error(`check-bundle: server-only content in the browser bundle:\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(
  `check-bundle: ${scanned} client assets contain no server-only packages or credentials`,
);
