import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chownSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import {
  AI_JOB_SCOPES,
  ANALYTICS_IDENTITY,
  KNOWLEDGE_IDENTITY,
  KNOWLEDGE_RETRIEVAL,
  NOTIFICATION_IDENTITY,
  TICKET_IDENTITY,
} from '@smartdesk/contracts';

const configRoot = '/run/smartdesk';
const statePath = configRoot + '/state/credentials.json';
const runtimeUid = 1000; // The node user in Dockerfile.dev.
const dataOwners = {
  ticket: 'TICKET',
  identity: 'IDENTITY',
  knowledge: 'KNOWLEDGE',
  analytics: 'ANALYTICS',
  notifications: 'NOTIFICATIONS',
  search: 'SEARCH',
};
const identityCallers = {
  ticket: { prefix: 'TICKET_IDENTITY', scope: TICKET_IDENTITY.scope },
  knowledge: { prefix: 'KNOWLEDGE', scope: KNOWLEDGE_IDENTITY.scope },
  analytics: { prefix: 'ANALYTICS', scope: ANALYTICS_IDENTITY.scope },
  notifications: { prefix: 'NOTIFICATIONS', scope: NOTIFICATION_IDENTITY.scope },
};
const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;

function databaseUrl(user, password) {
  const encodeComponent = (value) => encodeURIComponent(value).replaceAll("'", '%27');
  return (
    'postgresql://' +
    encodeComponent(user) +
    ':' +
    encodeComponent(password) +
    '@postgres:5432/' +
    encodeComponent(POSTGRES_DB)
  );
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function createCredentials() {
  return {
    suffix: randomBytes(8).toString('hex'),
    cursorSecret: randomBytes(32).toString('hex'),
    passwords: Object.fromEntries(
      Object.keys(dataOwners).map((service) => [service, randomBytes(32).toString('hex')]),
    ),
    keys: Object.fromEntries(
      [...Object.keys(identityCallers), 'ai'].map((service) => [
        service,
        generateKeyPairSync('ec', {
          namedCurve: 'P-256',
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }),
      ]),
    ),
  };
}

function loadCredentials() {
  const existing = readIfPresent(statePath);
  if (existing !== undefined) return JSON.parse(existing);

  const credentials = createCredentials();
  const temporaryPath = statePath + '.' + randomBytes(8).toString('hex');
  writeFileSync(temporaryPath, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
  try {
    // Publish once even if two startup commands reach an empty volume at the same time.
    linkSync(temporaryPath, statePath);
    return credentials;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } finally {
    unlinkSync(temporaryPath);
  }
}

function scopedRole(service, state) {
  if (!/^[0-9a-f]{16}$/.test(state.suffix) || !/^[0-9a-f]{64}$/.test(state.passwords[service])) {
    throw new Error('Invalid stored PostgreSQL credentials');
  }
  return 'smartdesk_local_' + service + '_' + state.suffix;
}

function roleSetup(state) {
  const roles = Object.keys(dataOwners).map((service) => {
    const role = scopedRole(service, state);
    return `
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
      ALTER ROLE ${role} PASSWORD '${state.passwords[service]}';
      GRANT smartdesk_${service} TO ${role} WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
    `;
  });
  return [
    'BEGIN;',
    'SELECT pg_catalog.pg_advisory_xact_lock(915091);',
    readFileSync('sql/service-access/roles.sql', 'utf8'),
    readFileSync('sql/service-access/enable.sql', 'utf8'),
    'DO $local_runtime$ BEGIN ' + roles.join('\n') + ' END $local_runtime$;',
    'COMMIT;',
  ].join('\n');
}

function registryEntry(state, service, grants) {
  return { kid: 'local-' + service, service, publicKey: state.keys[service].publicKey, grants };
}

function serviceConfigs(state) {
  const configs = Object.fromEntries(
    Object.entries(dataOwners).map(([service, prefix]) => [
      service,
      {
        [prefix + '_DATABASE_URL']: databaseUrl(
          scopedRole(service, state),
          state.passwords[service],
        ),
      },
    ]),
  );
  const identityRegistry = Object.entries(identityCallers).map(([service, { prefix, scope }]) => {
    const entry = registryEntry(state, service, { [scope]: 'user' });
    configs[service][prefix + '_KEY_ID'] = entry.kid;
    configs[service][prefix + '_PRIVATE_KEY'] = state.keys[service].privateKey;
    return entry;
  });
  const ai = registryEntry(
    state,
    'ai',
    Object.fromEntries(Object.values(AI_JOB_SCOPES).map((scope) => [scope, 'system'])),
  );
  configs.ai = { AI_SERVICE_KEY_ID: ai.kid, AI_SERVICE_PRIVATE_KEY: state.keys.ai.privateKey };
  configs.identity.INTERNAL_SERVICE_KEYS = JSON.stringify(identityRegistry);
  configs.ticket.INTERNAL_SERVICE_KEYS = JSON.stringify([ai]);
  configs.ticket.TICKET_SEARCH_CURSOR_SECRET = state.cursorSecret;
  configs.knowledge.KNOWLEDGE_RETRIEVAL_KEYS = JSON.stringify([
    registryEntry(state, 'ai', { [KNOWLEDGE_RETRIEVAL.scope]: 'system' }),
  ]);
  return configs;
}

function writeServiceConfig(service, config) {
  const path = configRoot + '/' + service + '/config.env';
  // Values are generated hex, PEM, JSON containing PEM keys, or encoded URLs.
  const contents = Object.entries(config)
    .map(([key, value]) => key + "='" + value + "'\n")
    .join('');
  if (readIfPresent(path) === contents) return;

  const temporaryPath = path + '.' + randomBytes(8).toString('hex');
  writeFileSync(temporaryPath, contents, { mode: 0o600, flag: 'wx' });
  try {
    chownSync(temporaryPath, runtimeUid, runtimeUid);
    renameSync(temporaryPath, path);
  } catch (error) {
    unlinkSync(temporaryPath);
    throw error;
  }
}

function prisma(operation, args, env, input) {
  const result = spawnSync('./node_modules/.bin/prisma', args, { env, input, encoding: 'utf8' });
  if (result.status === 0) return;

  // The CLI can include connection strings or SQL in errors.
  const code = result.stderr?.match(/\bP\d{4}\b/)?.[0];
  throw new Error(operation + ' failed' + (code ? ' (' + code + ')' : ''));
}

function main() {
  const env = { ...process.env, DATABASE_URL: databaseUrl(POSTGRES_USER, POSTGRES_PASSWORD) };
  const [command, ...args] = process.argv.slice(2);
  if (command) {
    const result = spawnSync(command, args, { env, stdio: 'inherit' });
    return result.status ?? 1;
  }

  console.log('Applying PostgreSQL migrations');
  prisma('Prisma migration', ['migrate', 'deploy'], env);
  console.log('Provisioning local PostgreSQL logins and service credentials');
  const state = loadCredentials();
  prisma('Service access setup', ['db', 'execute', '--stdin'], env, roleSetup(state));
  for (const [service, config] of Object.entries(serviceConfigs(state))) {
    writeServiceConfig(service, config);
  }
  console.log('Local service configuration is ready');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error('Local bootstrap failed: ' + error.message);
  process.exitCode = 1;
}
