export interface Env {
  host: string;
  port: number;
  frontendOrigin: string;
  databaseUrl: string;
  logLevel: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const port = Number(source.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${source.PORT}`);
  }
  return {
    host: source.HOST ?? '0.0.0.0',
    port,
    frontendOrigin: source.FRONTEND_ORIGIN ?? 'http://localhost:3000',
    databaseUrl: source.DATABASE_URL ?? 'postgres://smartdesk:smartdesk@localhost:5432/smartdesk',
    logLevel: source.LOG_LEVEL ?? 'info',
  };
}
