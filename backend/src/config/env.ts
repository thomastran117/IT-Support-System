export interface Env {
  host: string;
  port: number;
  frontendOrigin: string;
  databaseUrl: string;
  logLevel: string;
  production: boolean;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Secure flag on the refresh cookie. Defaults to on in production. */
  cookieSecure: boolean;
  /** AI recommendation provider. The key is backend/worker-only and must never be logged or sent to the browser. */
  ai: AiConfig;
}

export type AiProviderName = 'none' | 'fake' | 'openai';

export interface AiConfig {
  provider: AiProviderName;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  maxInputChars: number;
}

const AI_PROVIDERS: readonly AiProviderName[] = ['none', 'fake', 'openai'];

function loadAiConfig(source: NodeJS.ProcessEnv): AiConfig {
  const provider = (source.AI_PROVIDER || 'none') as AiProviderName;
  if (!AI_PROVIDERS.includes(provider)) {
    throw new Error(`Invalid AI_PROVIDER: must be one of ${AI_PROVIDERS.join(', ')}`);
  }
  const apiKey = source.AI_API_KEY ?? '';
  if (provider === 'openai' && !apiKey) {
    throw new Error('AI_API_KEY is required when AI_PROVIDER=openai');
  }
  return {
    provider,
    apiKey,
    model: source.AI_MODEL || 'gpt-4o-mini',
    timeoutMs: positiveInt(source, 'AI_TIMEOUT_MS', 20_000),
    maxOutputTokens: positiveInt(source, 'AI_MAX_OUTPUT_TOKENS', 1000),
    maxInputChars: positiveInt(source, 'AI_MAX_INPUT_CHARS', 20_000),
  };
}

const DEV_JWT_SECRET = 'change-me-dev-only-change-me-dev-only';

function positiveInt(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${key}: ${raw}`);
  return n;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const port = Number(source.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${source.PORT}`);
  }
  const production = source.NODE_ENV === 'production';

  let jwtSecret = source.JWT_SECRET;
  if (production) {
    if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.startsWith('change-me')) {
      throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
    }
  } else if (!jwtSecret || jwtSecret.length < 32) {
    // Development/test placeholder; never accepted in production (see above).
    jwtSecret = DEV_JWT_SECRET;
  }

  return {
    host: source.HOST ?? '0.0.0.0',
    port,
    frontendOrigin: source.FRONTEND_ORIGIN ?? 'http://localhost:3000',
    databaseUrl: source.DATABASE_URL ?? 'postgres://smartdesk:smartdesk@localhost:5432/smartdesk',
    logLevel: source.LOG_LEVEL ?? 'info',
    production,
    jwtSecret,
    jwtIssuer: source.JWT_ISSUER ?? 'smartdesk-api',
    jwtAudience: source.JWT_AUDIENCE ?? 'smartdesk-web',
    accessTtlSeconds: positiveInt(source, 'ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTtlSeconds: positiveInt(source, 'REFRESH_TOKEN_TTL_SECONDS', 7 * 24 * 60 * 60),
    cookieSecure: source.COOKIE_SECURE ? source.COOKIE_SECURE === 'true' : production,
    ai: loadAiConfig(source),
  };
}
