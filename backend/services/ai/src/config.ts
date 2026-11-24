import { parseHttpOrigin, parseInteger } from '@smartdesk/service-runtime';

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error('Invalid LOG_LEVEL');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: parseInteger('PORT', env.PORT ?? 4010, 1, 65535),
    logLevel,
    ticketOrigin: parseHttpOrigin(
      'AI_SERVICE_TICKET_ORIGIN',
      env.AI_SERVICE_TICKET_ORIGIN ?? 'http://localhost:4000',
    ),
    readyTimeoutMs: parseInteger(
      'AI_SERVICE_READY_TIMEOUT_MS',
      env.AI_SERVICE_READY_TIMEOUT_MS ?? 1500,
      1,
      5000,
    ),
  };
}
