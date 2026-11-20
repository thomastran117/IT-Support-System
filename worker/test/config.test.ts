import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from '../src/config.js';

describe('loadWorkerEnv', () => {
  it('uses defaults', () => {
    expect(loadWorkerEnv({}).pollIntervalMs).toBe(5000);
  });
  it('rejects an invalid interval', () => {
    expect(() => loadWorkerEnv({ WORKER_POLL_INTERVAL_MS: 'x' })).toThrow();
  });
});
