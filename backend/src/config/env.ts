import { loadEmailConfig, type EmailConfig } from '@smartdesk/notifications';
import { loadAiConfig, loadAiExecutionMode, type AiConfig } from '@smartdesk/ai-analysis';
import { loadSessionConfig, type TokenConfig } from '@smartdesk/identity';
import { parseExecutionMode, parseIdentityOrigin } from '@smartdesk/service-runtime';
import { loadServiceKeys } from '../auth/serviceTokens.js';

export type { EmailConfig } from '@smartdesk/notifications';

export interface Env extends TokenConfig {
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
  ticketSearchCursorSecret: string;
  identity: { identityOrigin: URL; keyId: string; privateKey: string } | undefined;
  internalServiceKeys: ReturnType<typeof loadServiceKeys>;
  /** Secure flag on the refresh cookie. Defaults to on in production. */
  cookieSecure: boolean;
  /** Provider and queue settings for the selected analysis execution mode. */
  ai: AiConfig;
  aiExecutionMode: ReturnType<typeof loadAiExecutionMode>;
  notificationsExecutionMode: 'local' | 'service';
  analyticsExecutionMode: 'local' | 'service';
  knowledgeExecutionMode: 'local' | 'service';
  /** Optional email channel for notifications (SD-043). Off unless EMAIL_TRANSPORT=smtp. */
  email: EmailConfig;
}

export type TrustProxy = boolean | string[];

export type OpenSearchConfig =
  | { enabled: false }
  | { enabled: true; url: string; auth?: { username: string; password: string } };

export function loadOpenSearchConfig(
  source: NodeJS.ProcessEnv,
  production: boolean,
): OpenSearchConfig {
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

function loadTicketIdentity(source: NodeJS.ProcessEnv) {
  const identityOrigin = parseIdentityOrigin(source);
  const keyId = source.TICKET_IDENTITY_KEY_ID ?? '';
  const privateKey = source.TICKET_IDENTITY_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) || !privateKey.trim()) {
    throw new Error('TICKET_IDENTITY_KEY_ID and TICKET_IDENTITY_PRIVATE_KEY are required');
  }
  return { identityOrigin, keyId, privateKey };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const port = Number(source.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${source.PORT}`);
  }
  const production = source.NODE_ENV === 'production';
  const aiExecutionMode = loadAiExecutionMode(source);
  const notificationsExecutionMode = source.NOTIFICATIONS_EXECUTION_MODE || 'local';
  if (notificationsExecutionMode !== 'local' && notificationsExecutionMode !== 'service') {
    throw new Error('NOTIFICATIONS_EXECUTION_MODE must be local or service');
  }
  const analyticsExecutionMode = source.ANALYTICS_EXECUTION_MODE || 'local';
  if (analyticsExecutionMode !== 'local' && analyticsExecutionMode !== 'service') {
    throw new Error('ANALYTICS_EXECUTION_MODE must be local or service');
  }

  const remoteIdentity =
    parseExecutionMode('IDENTITY_EXECUTION_MODE', source.IDENTITY_EXECUTION_MODE) === 'service';
  const session = loadSessionConfig(source, !remoteIdentity);
  const ticketSearchCursorSecret =
    source.TICKET_SEARCH_CURSOR_SECRET ||
    (remoteIdentity ? 'change-me-development-ticket-search-only' : session.jwtSecret);
  if (
    production &&
    (ticketSearchCursorSecret.length < 32 || ticketSearchCursorSecret.startsWith('change-me'))
  ) {
    throw new Error(
      'TICKET_SEARCH_CURSOR_SECRET must be set to a random value of at least 32 characters',
    );
  }

  return {
    host: source.HOST ?? '0.0.0.0',
    port,
    ...session,
    databaseUrl: source.DATABASE_URL ?? 'postgres://smartdesk:smartdesk@localhost:5432/smartdesk',
    redisUrl: source.REDIS_URL || undefined,
    openSearch: loadOpenSearchConfig(source, production),
    trustProxy: loadTrustProxy(source.TRUST_PROXY),
    logLevel: source.LOG_LEVEL ?? 'info',
    production,
    ticketSearchCursorSecret,
    identity: remoteIdentity ? loadTicketIdentity(source) : undefined,
    internalServiceKeys: loadServiceKeys(source.INTERNAL_SERVICE_KEYS),
    ai: loadAiConfig(source, aiExecutionMode === 'local'),
    aiExecutionMode,
    notificationsExecutionMode,
    analyticsExecutionMode,
    knowledgeExecutionMode: parseExecutionMode(
      'KNOWLEDGE_EXECUTION_MODE',
      source.KNOWLEDGE_EXECUTION_MODE,
    ),
    email: loadEmailConfig(
      notificationsExecutionMode === 'local' ? source : { ...source, EMAIL_TRANSPORT: 'none' },
    ),
  };
}
