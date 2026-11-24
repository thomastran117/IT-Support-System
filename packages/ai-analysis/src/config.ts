export type AiProviderName = 'none' | 'fake' | 'openai';

export function loadAiExecutionMode(env: NodeJS.ProcessEnv): 'local' | 'service' {
  const mode = env.AI_EXECUTION_MODE || 'local';
  if (mode !== 'local' && mode !== 'service') {
    throw new Error('AI_EXECUTION_MODE must be local or service');
  }
  return mode;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
  return value;
}

export function loadAiConfig(env: NodeJS.ProcessEnv, requireProviderKey = true) {
  const provider = env.AI_PROVIDER || 'none';
  if (provider !== 'none' && provider !== 'fake' && provider !== 'openai') {
    throw new Error('Invalid AI_PROVIDER: must be one of none, fake, openai');
  }
  const apiKey = requireProviderKey ? (env.AI_API_KEY ?? '') : '';
  if (requireProviderKey && provider === 'openai' && !apiKey) {
    throw new Error('AI_API_KEY is required when AI_PROVIDER=openai');
  }
  return {
    provider: provider as AiProviderName,
    apiKey,
    model: env.AI_MODEL || 'gpt-4o-mini',
    timeoutMs: positiveInt(env, 'AI_TIMEOUT_MS', 20_000),
    maxOutputTokens: positiveInt(env, 'AI_MAX_OUTPUT_TOKENS', 1000),
    maxInputChars: positiveInt(env, 'AI_MAX_INPUT_CHARS', 20_000),
    worker: {
      concurrency: positiveInt(env, 'AI_WORKER_CONCURRENCY', 2),
      pollIntervalMs: positiveInt(env, 'WORKER_POLL_INTERVAL_MS', 5000),
      maxAttempts: positiveInt(env, 'AI_JOB_MAX_ATTEMPTS', 3),
      backoffBaseMs: positiveInt(env, 'AI_JOB_BACKOFF_MS', 5000),
    },
  };
}

export type AiConfig = ReturnType<typeof loadAiConfig>;

export const analysisTimeoutMs = (config: AiConfig) => config.timeoutMs + 10_000;
export const analysisLeaseMs = (config: AiConfig) => analysisTimeoutMs(config) + 30_000;
