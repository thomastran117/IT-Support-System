/**
 * Regenerate docs/database/erd.md and docs/database/data-dictionary.md from schema-spec.json.
 *
 *   npm run docs:db -w backend
 *
 * After changing a migration, update docs/database/schema-spec.json (the dictionary test prints
 * what differs from the live database), then run this command and commit the results.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderDictionary, renderErd, type SchemaSpec } from '../src/db/docs/render.js';

const dir = fileURLToPath(new URL('../../docs/database/', import.meta.url));
const spec = JSON.parse(readFileSync(`${dir}schema-spec.json`, 'utf8')) as SchemaSpec;

writeFileSync(`${dir}erd.md`, renderErd(spec), 'utf8');
writeFileSync(`${dir}data-dictionary.md`, renderDictionary(spec), 'utf8');
console.log(`Wrote erd.md and data-dictionary.md for ${spec.tables.length} tables`);
