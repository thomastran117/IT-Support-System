import { loadEmailConfig } from '@smartdesk/notifications';
import { parseIdentityOrigin, parseInteger } from '@smartdesk/service-runtime';

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.NOTIFICATIONS_DATABASE_URL;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('NOTIFICATIONS_DATABASE_URL must reference the scoped PostgreSQL login');
  }
  const identityOrigin = parseIdentityOrigin(env, 'NOTIFICATIONS_IDENTITY_ORIGIN');
  const keyId = env.NOTIFICATIONS_KEY_ID ?? '';
  const privateKey = env.NOTIFICATIONS_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) || !privateKey.trim()) {
    throw new Error('NOTIFICATIONS_KEY_ID and NOTIFICATIONS_PRIVATE_KEY are required');
  }
  return {
    databaseUrl,
    identityOrigin,
    keyId,
    privateKey,
    host: env.HOST ?? '127.0.0.1',
    port: parseInteger('PORT', env.PORT ?? 4020, 1, 65535),
    pollMs: parseInteger('WORKER_POLL_INTERVAL_MS', env.WORKER_POLL_INTERVAL_MS ?? 5000, 1, 60_000),
    frontendOrigin: env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
    logLevel: env.LOG_LEVEL ?? 'info',
    email: loadEmailConfig(env),
  };
}
