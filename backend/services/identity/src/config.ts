import { loadSessionConfig } from '@smartdesk/identity';
import { parseInteger } from '@smartdesk/service-runtime';
import { loadServiceKeys } from '@smartdesk/service-runtime/service-tokens';

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.IDENTITY_DATABASE_URL;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('IDENTITY_DATABASE_URL must reference the scoped PostgreSQL login');
  }
  return {
    databaseUrl,
    host: env.HOST ?? '127.0.0.1',
    port: parseInteger('PORT', env.PORT ?? 4050, 1, 65535),
    session: loadSessionConfig(env),
    internalServiceKeys: loadServiceKeys(env.INTERNAL_SERVICE_KEYS),
    logLevel: env.LOG_LEVEL ?? 'info',
    redisUrl: env.REDIS_URL || undefined,
  };
}
