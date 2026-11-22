import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';
import {
  changeRoleSchema,
  createTicketSchema,
  createUserSchema,
  loginSchema,
  transitionSchema,
  type ApiEnvelope,
  type ApiErrorEnvelope,
  type Paginated,
  type TicketPage,
  type TransitionRequest,
} from '../src/index.js';

describe('public runtime surface', () => {
  // Renaming or removing an export breaks every consumer; make that a deliberate, reviewed change.
  it('keeps its exported names stable', () => {
    expect(Object.keys(contracts).sort()).toMatchSnapshot();
  });
});

describe('shared request schemas', () => {
  it('normalises and bounds login input', () => {
    expect(loginSchema.parse({ email: '  Erin@Example.COM ', password: 'x' })).toEqual({
      email: 'erin@example.com',
      password: 'x',
    });
    expect(loginSchema.safeParse({ email: '', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.c', password: 'x'.repeat(1025) }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields on transitions and user changes', () => {
    expect(
      transitionSchema.safeParse({ to: 'RESOLVED', expectedVersion: 2, role: 'ADMIN' }).success,
    ).toBe(false);
    expect(transitionSchema.safeParse({ to: 'RESOLVED' }).success).toBe(false);
    expect(transitionSchema.safeParse({ to: 'OPEN', expectedVersion: 0 }).success).toBe(false);
    expect(transitionSchema.safeParse({ to: 'DONE', expectedVersion: 1 }).success).toBe(false);
    expect(changeRoleSchema.safeParse({ role: 'ADMIN', extra: 1 }).success).toBe(false);
  });

  it('validates new accounts', () => {
    const ok = createUserSchema.parse({
      email: 'New@Example.com',
      displayName: ' Nia ',
      role: 'TECHNICIAN',
    });
    expect(ok).toEqual({ email: 'new@example.com', displayName: 'Nia', role: 'TECHNICIAN' });
    expect(
      createUserSchema.safeParse({ email: 'nope', displayName: 'x', role: 'ADMIN' }).success,
    ).toBe(false);
    expect(
      createUserSchema.safeParse({ email: 'a@b.co', displayName: 'x', role: 'ROOT' }).success,
    ).toBe(false);
  });

  it('keeps ticket creation strict', () => {
    expect(createTicketSchema.safeParse({ title: 't', description: 'd' }).success).toBe(true);
    expect(
      createTicketSchema.safeParse({ title: 't', description: 'd', requesterId: 'x' }).success,
    ).toBe(false);
  });
});

describe('transport types', () => {
  it('a request type matches its schema output', () => {
    const body: TransitionRequest = { to: 'RESOLVED', expectedVersion: 3, resolutionSummary: 'ok' };
    expect(transitionSchema.parse(body)).toEqual(body);
  });

  it('every list endpoint shares the Paginated shape', () => {
    const page: TicketPage = { items: [], total: 0, limit: 20, offset: 0, nextOffset: null };
    const generic: Paginated<unknown> = page;
    expect(generic.items).toEqual([]);
  });

  it('an error envelope always has an error name and no data', () => {
    const failure: ApiErrorEnvelope = {
      message: 'Validation failed',
      error: 'Bad Request',
      details: { title: ['Required'] },
      data: null,
    };
    const asEnvelope: ApiEnvelope<null> = failure;
    expect(asEnvelope.data).toBeNull();
  });

  it('breaking a DTO is a compile error', () => {
    // @ts-expect-error `to` must be a TicketStatus
    const badStatus: TransitionRequest = { to: 'DONE', expectedVersion: 1 };
    // @ts-expect-error `expectedVersion` is required
    const missingVersion: TransitionRequest = { to: 'OPEN' };
    // @ts-expect-error an error envelope must name the error
    const noError: ApiErrorEnvelope = { message: 'x', error: null, details: null, data: null };
    expect([badStatus, missingVersion, noError]).toHaveLength(3);
  });
});
