import { loadAiConfig, loadAiExecutionMode, type AiConfig } from '@smartdesk/ai-analysis';
import { loadServiceKeys } from '../auth/serviceTokens.js';

export interface Env {
  host: string;
  port: number;
  frontendOrigin: string;
  databaseUrl: string;
  /** Optional internal cache. Undefined means Redis is disabled; see backend/src/cache/client.ts. */
  redisUrl: string | undefined;
  openSearch: OpenSearchConfig;
  /** Fastify's own `trustProxy`. false (default) never trusts a forwarded-for header, so a
   * client cannot spoof the IP a rate limiter keys on; set it only when a specific, known
   * reverse proxy sits in front of this deployment. */
  trustProxy: TrustProxy;
  logLevel: string;
  production: boolean;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  internalServiceKeys: ReturnType<typeof loadServiceKeys>;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Secure flag on the refresh cookie. Defaults to on in production. */
  cookieSecure: boolean;
  /** Provider and queue settings for the selected analysis execution mode. */
  ai: AiConfig;
  aiExecutionMode: ReturnType<typeof loadAiExecutionMode>;
  /** Optional email channel for notifications (SD-043). Off unless EMAIL_TRANSPORT=smtp. */
  email: EmailConfig;
}

export type TrustProxy = boolean | string[];

export type OpenSearchConfig =
  | { enabled: false }
  | { enabled: true; url: string; auth?: { username: string; password: string } };

export type EmailTransportName = 'none' | 'smtp';

export interface EmailConfig {
  transport: EmailTransportName;
  /** Defaults target Gmail: smtp.gmail.com, port 587 with STARTTLS. */
  host: string;
  port: number;
  /** Implicit TLS (port 465). When false the connection must upgrade with STARTTLS. */
  secure: boolean;
  user: string;
  /** For Gmail this is an App Password. Worker-only: never logged, never sent to the browser. */
  password: string;
  /** From address. Gmail rewrites it to the authenticated account unless an alias is verified. */
  from: string;
  /** Public web origin used to build ticket links in emails. */
  appBaseUrl: string;
  maxAttempts: number;
  backoffBaseMs: number;
  /** Notifications older than this are never emailed (stale news after an outage or when enabling). */
  maxAgeMs: number;
}

function loadOpenSearchConfig(source: NodeJS.ProcessEnv, production: boolean): OpenSearchConfig {
  const enabled = source.OPENSEARCH_ENABLED || 'false';
  if (enabled === 'false') return { enabled: false };
  if (enabled !== 'true') throw new Error('OPENSEARCH_ENABLED must be true or false');

  const rawUrl = source.OPENSEARCH_URL?.trim() ?? '';
  const endpoint = URL.parse(rawUrl);
  if (!/^https?:\/\//i.test(rawUrl) || !endpoint || endpoint.username || endpoint.password) {
    throw new Error('OPENSEARCH_URL must be an absolute HTTP(S) URL without embedded credentials');
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error('OPENSEARCH_URL must not contain a query or fragment');
  }
  if (production && endpoint.protocol !== 'https:') {
    throw new Error('OPENSEARCH_URL must use HTTPS in production');
  }

  const username = source.OPENSEARCH_USERNAME?.trim();
  const password = source.OPENSEARCH_PASSWORD;
  if (username && password)
    return { enabled: true, url: endpoint.href, auth: { username, password } };
  if (production || username || password) {
    throw new Error(
      'OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD are both required for authentication',
    );
  }
  return { enabled: true, url: endpoint.href };
}

const EMAIL_TRANSPORTS: readonly EmailTransportName[] = ['none', 'smtp'];

function loadEmailConfig(source: NodeJS.ProcessEnv): EmailConfig {
  const transport = (source.EMAIL_TRANSPORT || 'none') as EmailTransportName;
  if (!EMAIL_TRANSPORTS.includes(transport)) {
    throw new Error(`Invalid EMAIL_TRANSPORT: must be one of ${EMAIL_TRANSPORTS.join(', ')}`);
  }
  const user = source.SMTP_USER ?? '';
  const password = source.SMTP_PASSWORD ?? '';
  if (transport === 'smtp' && (!user || !password)) {
    throw new Error('SMTP_USER and SMTP_PASSWORD are required when EMAIL_TRANSPORT=smtp');
  }
  const appBaseUrl = (source.APP_BASE_URL || source.FRONTEND_ORIGIN || 'http://localhost:3000')
    .trim()
    .replace(/\/+$/, '');
  if (transport === 'smtp' && !/^https?:\/\//.test(appBaseUrl)) {
    throw new Error('APP_BASE_URL must start with http:// or https://');
  }
  const port = positiveInt(source, 'SMTP_PORT', 587);
  return {
    transport,
    host: source.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: source.SMTP_SECURE ? source.SMTP_SECURE === 'true' : port === 465,
    user,
    password,
    from: source.SMTP_FROM || user,
    appBaseUrl,
    maxAttempts: positiveInt(source, 'EMAIL_JOB_MAX_ATTEMPTS', 5),
    backoffBaseMs: positiveInt(source, 'EMAIL_JOB_BACKOFF_MS', 30_000),
    maxAgeMs: positiveInt(source, 'EMAIL_MAX_AGE_HOURS', 24) * 3_600_000,
  };
}

/** false (never trust a forwarded-for header) unless explicitly opted in: `true` (trust it
 * unconditionally -- only safe if every request genuinely passes through your own proxy), or a
 * comma-separated list of trusted proxy IPs/CIDRs. */
function loadTrustProxy(raw: string | undefined): TrustProxy {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
  const aiExecutionMode = loadAiExecutionMode(source);

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
    redisUrl: source.REDIS_URL || undefined,
    openSearch: loadOpenSearchConfig(source, production),
    trustProxy: loadTrustProxy(source.TRUST_PROXY),
    logLevel: source.LOG_LEVEL ?? 'info',
    production,
    jwtSecret,
    jwtIssuer: source.JWT_ISSUER ?? 'smartdesk-api',
    jwtAudience: source.JWT_AUDIENCE ?? 'smartdesk-web',
    internalServiceKeys: loadServiceKeys(source.INTERNAL_SERVICE_KEYS),
    accessTtlSeconds: positiveInt(source, 'ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTtlSeconds: positiveInt(source, 'REFRESH_TOKEN_TTL_SECONDS', 7 * 24 * 60 * 60),
    cookieSecure: source.COOKIE_SECURE ? source.COOKIE_SECURE === 'true' : production,
    ai: loadAiConfig(source, aiExecutionMode === 'local'),
    aiExecutionMode,
    email: loadEmailConfig(source),
  };
}
