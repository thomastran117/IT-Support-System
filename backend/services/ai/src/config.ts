import { loadAiConfig, loadAiExecutionMode } from '@smartdesk/ai-analysis';
import { parseHttpOrigin, parseInteger } from '@smartdesk/service-runtime';

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error('Invalid LOG_LEVEL');
  }
  const aiExecutionMode = loadAiExecutionMode(env);
  const ai = loadAiConfig(env, aiExecutionMode === 'service');
  const ticketOrigin = parseHttpOrigin(
    'AI_SERVICE_TICKET_ORIGIN',
    env.AI_SERVICE_TICKET_ORIGIN ?? 'http://localhost:4000',
  );
  const active = aiExecutionMode === 'service' && ai.provider !== 'none';
  const kid = env.AI_SERVICE_KEY_ID ?? '';
  const privateKey = env.AI_SERVICE_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
  if (active && (!/^[a-zA-Z0-9_-]{1,64}$/.test(kid) || !privateKey.trim())) {
    throw new Error(
      'AI_SERVICE_KEY_ID and AI_SERVICE_PRIVATE_KEY are required for active AI execution',
    );
  }
  if (active && env.NODE_ENV === 'production' && ticketOrigin.protocol !== 'https:') {
    throw new Error('AI_SERVICE_TICKET_ORIGIN must use HTTPS in production');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: parseInteger('PORT', env.PORT ?? 4010, 1, 65535),
    logLevel,
    ticketOrigin,
    ai,
    signing: active ? { kid, privateKey } : null,
    readyTimeoutMs: parseInteger(
      'AI_SERVICE_READY_TIMEOUT_MS',
      env.AI_SERVICE_READY_TIMEOUT_MS ?? 1500,
      1,
      5000,
    ),
  };
}
