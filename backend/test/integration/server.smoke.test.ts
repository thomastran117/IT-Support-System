import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

describe('server process', () => {
  it('starts, serves /health/live and stops on SIGTERM', async () => {
    const port = 4590 + Math.floor(Math.random() * 100);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'silent' },
      stdio: 'ignore',
    });
    let ok = false;
    for (let i = 0; i < 80 && !ok; i++) {
      try {
        ok = (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(ok).toBe(true);
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit');
    // On Windows SIGTERM terminates the process without running handlers.
    expect(code === 0 || signal === 'SIGTERM').toBe(true);
  }, 30_000);
});
