import type { PrismaClient } from '@smartdesk/db';
import { deliverServiceEvent } from '@smartdesk/notifications';
import { describe, expect, it, vi } from 'vitest';

/**
 * SD-053: delivery outcomes of the service outbox consumer without PostgreSQL. The receipt update
 * and the consumer's effect share one transaction under the claimed lease; the integration suite
 * (serviceOutbox.integration.test.ts) covers the SQL itself, including ON CONFLICT on claims.
 */
const eventId = '6f0c2f8e-4c1b-4c7e-9a43-2d5b1f6c9a10';
const row = {
  eventId,
  schemaVersion: 1,
  type: 'ticket.created',
  occurredAt: new Date('2026-03-02T14:00:00Z'),
  aggregateId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  aggregateVersion: 1,
  correlationId: 'a'.repeat(64),
  payload: {},
};
const claim = (attempts: number) => ({
  consumer: 'notifications',
  eventId,
  leaseToken: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  attempts,
});

/** Tagged-template values: what the final receipt update set (state, error, retry flag, delay). */
type Raw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;

function fakeDb(options: { event?: object; leaseHeld?: boolean; finalRows?: number }) {
  const txUpdate = vi.fn<Raw>(async () => (options.leaseHeld === false ? 0 : 1));
  const finalUpdate = vi.fn<Raw>(async () => options.finalRows ?? 1);
  const tx = {
    serviceOutboxEvent: { findUniqueOrThrow: vi.fn(async () => options.event ?? row) },
    $executeRaw: txUpdate,
  };
  const db = {
    $transaction: vi.fn(async (work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    $executeRaw: finalUpdate,
  } as unknown as PrismaClient;
  return { db, txUpdate, finalUpdate };
}

describe('deliverServiceEvent', () => {
  it('applies a valid event once and completes the receipt in the same transaction', async () => {
    const { db, txUpdate, finalUpdate } = fakeDb({});
    const apply = vi.fn(async () => {});
    expect(await deliverServiceEvent(db, claim(1), apply)).toBe('COMPLETED');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.anything(), {
      ...row,
      occurredAt: '2026-03-02T14:00:00.000Z',
    });
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(finalUpdate).not.toHaveBeenCalled();
  });

  it('never applies the effect when another worker took over the lease', async () => {
    const { db } = fakeDb({ leaseHeld: false });
    const apply = vi.fn(async () => {});
    expect(await deliverServiceEvent(db, claim(2), apply)).toBe('LOST');
    expect(apply).not.toHaveBeenCalled();
  });

  it('dead-letters a malformed event without retrying or applying it', async () => {
    const { db, finalUpdate } = fakeDb({ event: { ...row, type: 'ticket.unknown' } });
    const apply = vi.fn(async () => {});
    expect(await deliverServiceEvent(db, claim(1), apply)).toBe('FAILED');
    expect(apply).not.toHaveBeenCalled();
    const values = finalUpdate.mock.calls[0]!.slice(1);
    expect(values).toContain('invalid_event');
    expect(values).toContain(false);
  });

  it('requeues a failed effect with exponential backoff, then dead-letters on the last attempt', async () => {
    const failing = vi.fn(async () => {
      throw new Error('inbox write failed');
    });
    for (const [attempts, state, delayMs] of [
      [1, 'QUEUED', 5000],
      [3, 'QUEUED', 20000],
      [5, 'FAILED', 80000],
    ] as const) {
      const { db, finalUpdate } = fakeDb({});
      expect(await deliverServiceEvent(db, claim(attempts), failing)).toBe(state);
      const values = finalUpdate.mock.calls[0]!.slice(1);
      expect(values).toContain(state);
      expect(values).toContain('handler_failed');
      expect(values).toContain(state === 'QUEUED');
      expect(values).toContain(delayMs);
    }
  });

  it('reports LOST when the lease expired before a failure could be recorded', async () => {
    const { db } = fakeDb({ finalRows: 0 });
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await deliverServiceEvent(db, claim(1), failing)).toBe('LOST');
  });
});
