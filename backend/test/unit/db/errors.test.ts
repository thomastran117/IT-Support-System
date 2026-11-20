import { describe, expect, it, vi } from 'vitest';
import { closePrisma, getPrisma, initPrisma } from '../../../src/db/client.js';
import { DbError, isRetryable, mapDbError } from '../../../src/db/errors.js';
import { withTransaction } from '../../../src/db/transaction.js';

const SECRET = 'postgres://user:hunter2@db.internal:5432/smartdesk';

function adapterError(sqlstate: string, message = `boom ${SECRET} SELECT * FROM tickets`) {
  return {
    code: undefined,
    message,
    meta: { driverAdapterError: { cause: { originalCode: sqlstate } } },
  };
}

describe('mapDbError', () => {
  it.each([
    ['23505', 'CONFLICT', 409],
    ['23503', 'REFERENCE', 409],
    ['23001', 'REFERENCE', 409],
    ['23514', 'CONSTRAINT', 422],
    ['23502', 'CONSTRAINT', 422],
    ['40001', 'RETRYABLE', 409],
    ['40P01', 'RETRYABLE', 409],
  ])('maps SQLSTATE %s to %s', (state, code, status) => {
    const mapped = mapDbError(adapterError(state));
    expect(mapped).toBeInstanceOf(DbError);
    expect(mapped.code).toBe(code);
    expect(mapped.statusCode).toBe(status);
  });

  it('maps Prisma known-request codes', () => {
    expect(mapDbError({ code: 'P2002' }).code).toBe('CONFLICT');
    expect(mapDbError({ code: 'P2003' }).code).toBe('REFERENCE');
    expect(mapDbError({ code: 'P2025' }).code).toBe('NOT_FOUND');
    expect(mapDbError({ code: 'P2034' }).code).toBe('RETRYABLE');
    expect(mapDbError({ code: 'P2028' }).code).toBe('TIMEOUT');
  });

  it('reports database outages as 503', () => {
    for (const code of ['P1001', 'P1002', 'P1017', 'P2024']) {
      const mapped = mapDbError({ code });
      expect(mapped.code).toBe('UNAVAILABLE');
      expect(mapped.statusCode).toBe(503);
    }
  });

  it('never leaks SQL, connection strings or raw messages', () => {
    for (const state of ['23505', '23503', '23514', '40001']) {
      const text = JSON.stringify(mapDbError(adapterError(state)));
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('SELECT');
    }
    const unknown = mapDbError(new Error(`connect failed to ${SECRET}`));
    expect(unknown.code).toBe('UNKNOWN');
    expect(unknown.message).toBe('Internal server error');
  });

  it('reads the SQLSTATE from a raw-query message', () => {
    expect(mapDbError({ message: 'Raw query failed. Code: `23514`. Message: ...' }).code).toBe(
      'CONSTRAINT',
    );
  });

  it('passes typed errors through unchanged', () => {
    const typed = new DbError('NOT_FOUND', 404, 'Ticket not found');
    expect(mapDbError(typed)).toBe(typed);
  });
});

describe('isRetryable', () => {
  it('flags serialization failures and deadlocks only', () => {
    expect(isRetryable(adapterError('40001'))).toBe(true);
    expect(isRetryable(adapterError('40P01'))).toBe(true);
    expect(isRetryable(adapterError('23505'))).toBe(false);
  });
});

describe('withTransaction', () => {
  const fakePrisma = (impl: () => Promise<unknown>) =>
    ({ $transaction: vi.fn(impl) }) as unknown as Parameters<typeof withTransaction>[0];

  it('retries serialization failures, then succeeds', async () => {
    let calls = 0;
    const prisma = fakePrisma(async () => {
      if (++calls < 3) throw adapterError('40001');
      return 'ok';
    });
    await expect(withTransaction(prisma, async () => 'ignored')).resolves.toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget with a safe error', async () => {
    const prisma = fakePrisma(async () => {
      throw adapterError('40001');
    });
    await expect(withTransaction(prisma, async () => 1, { retries: 1 })).rejects.toMatchObject({
      code: 'RETRYABLE',
    });
  });

  it('does not retry integrity violations', async () => {
    const impl = vi.fn(async () => {
      throw adapterError('23505');
    });
    const prisma = { $transaction: impl } as unknown as Parameters<typeof withTransaction>[0];
    await expect(withTransaction(prisma, async () => 1)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('passes bounded duration options to Prisma', async () => {
    const impl = vi.fn(async () => 'ok');
    const prisma = { $transaction: impl } as unknown as Parameters<typeof withTransaction>[0];
    await withTransaction(prisma, async () => 1, { maxWaitMs: 111, timeoutMs: 222 });
    expect(impl).toHaveBeenCalledWith(expect.any(Function), { maxWait: 111, timeout: 222 });
  });
});

describe('client lifecycle', () => {
  it('is a singleton that can be closed repeatedly', async () => {
    const url = 'postgres://u:p@127.0.0.1:1/none';
    const a = initPrisma(url);
    expect(initPrisma(url)).toBe(a);
    expect(getPrisma()).toBe(a);
    await closePrisma();
    await closePrisma();
    expect(() => getPrisma()).toThrow(/not initialised/);
  });
});
