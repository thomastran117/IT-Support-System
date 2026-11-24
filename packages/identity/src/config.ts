export interface TokenConfig {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

const DEV_JWT_SECRET = 'change-me-dev-only-change-me-dev-only';

function positiveInt(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${key}: ${raw}`);
  return n;
}

export function loadSessionConfig(source: NodeJS.ProcessEnv, signingEnabled = true) {
  const production = source.NODE_ENV === 'production';
  let jwtSecret = signingEnabled ? (source.JWT_SECRET ?? '') : '';
  if (signingEnabled) {
    if (production && (jwtSecret.length < 32 || jwtSecret.startsWith('change-me'))) {
      throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
    }
    if (jwtSecret.length < 32) jwtSecret = DEV_JWT_SECRET;
  }
  return {
    jwtSecret,
    jwtIssuer: source.JWT_ISSUER ?? 'smartdesk-api',
    jwtAudience: source.JWT_AUDIENCE ?? 'smartdesk-web',
    accessTtlSeconds: positiveInt(source, 'ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTtlSeconds: positiveInt(source, 'REFRESH_TOKEN_TTL_SECONDS', 7 * 24 * 60 * 60),
    cookieSecure: source.COOKIE_SECURE ? source.COOKIE_SECURE === 'true' : production,
    frontendOrigin: source.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  };
}
