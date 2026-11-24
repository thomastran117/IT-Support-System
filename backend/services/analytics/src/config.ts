import { parseIdentityOrigin, parseInteger } from '@smartdesk/service-runtime';

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.ANALYTICS_DATABASE_URL;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('ANALYTICS_DATABASE_URL must reference the scoped PostgreSQL login');
  }
  const identityOrigin = parseIdentityOrigin(env, 'ANALYTICS_IDENTITY_ORIGIN');
  const keyId = env.ANALYTICS_KEY_ID ?? '';
  const privateKey = env.ANALYTICS_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) || !privateKey.trim()) {
    throw new Error('ANALYTICS_KEY_ID and ANALYTICS_PRIVATE_KEY are required');
  }
  return {
    databaseUrl,
    identityOrigin,
    keyId,
    privateKey,
    host: env.HOST ?? '127.0.0.1',
    port: parseInteger('PORT', env.PORT ?? 4030, 1, 65535),
    frontendOrigin: env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
