export interface WorkerEnv {
  databaseUrl: string;
  pollIntervalMs: number;
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const pollIntervalMs = Number(source.WORKER_POLL_INTERVAL_MS ?? 5000);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100) {
    throw new Error(`Invalid WORKER_POLL_INTERVAL_MS: ${source.WORKER_POLL_INTERVAL_MS}`);
  }
  return {
    databaseUrl: source.DATABASE_URL ?? 'postgres://smartdesk:smartdesk@localhost:5432/smartdesk',
    pollIntervalMs,
  };
}
