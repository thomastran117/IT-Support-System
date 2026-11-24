import { parseIdentityOrigin, parseInteger } from '@smartdesk/service-runtime';
import { loadServiceKeys } from '@smartdesk/service-runtime/service-tokens';

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.KNOWLEDGE_DATABASE_URL;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('KNOWLEDGE_DATABASE_URL must reference the scoped PostgreSQL login');
  }
  const identityOrigin = parseIdentityOrigin(env, 'KNOWLEDGE_IDENTITY_ORIGIN');
  const keyId = env.KNOWLEDGE_KEY_ID ?? '';
  const privateKey = env.KNOWLEDGE_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) || !privateKey.trim()) {
    throw new Error('KNOWLEDGE_KEY_ID and KNOWLEDGE_PRIVATE_KEY are required');
  }
  const retrievalKeys = loadServiceKeys(env.KNOWLEDGE_RETRIEVAL_KEYS);
  return {
    databaseUrl,
    identityOrigin,
    keyId,
    privateKey,
    retrievalKeys,
    host: env.HOST ?? '127.0.0.1',
    port: parseInteger('PORT', env.PORT ?? 4040, 1, 65535),
    frontendOrigin: env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
