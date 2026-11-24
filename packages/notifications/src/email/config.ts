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

function positiveInt(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${key}: ${raw}`);
  return n;
}

const EMAIL_TRANSPORTS: readonly EmailTransportName[] = ['none', 'smtp'];

export function loadEmailConfig(source: NodeJS.ProcessEnv): EmailConfig {
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
