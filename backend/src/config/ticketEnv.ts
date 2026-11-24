import { loadEnv, type Env } from './env.js';

/** The scoped runtime serves only Ticket routes, over its own PostgreSQL login. */
export function loadTicketEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const databaseUrl = source.TICKET_DATABASE_URL;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('TICKET_DATABASE_URL must reference the scoped PostgreSQL login');
  }
  return loadEnv({
    ...source,
    DATABASE_URL: databaseUrl,
    IDENTITY_EXECUTION_MODE: 'service',
    KNOWLEDGE_EXECUTION_MODE: 'service',
    ANALYTICS_EXECUTION_MODE: 'service',
    NOTIFICATIONS_EXECUTION_MODE: 'service',
    AI_EXECUTION_MODE: 'service',
  });
}
