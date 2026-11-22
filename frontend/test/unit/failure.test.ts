import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../../src/lib/auth/client';
import { toFailure } from '../../src/lib/forms/failure';

describe('toFailure', () => {
  it('treats an outage as retryable and promises the input is kept', () => {
    const failure = toFailure(new NetworkError());
    expect(failure).toMatchObject({ kind: 'network', retryable: true, stale: false });
    expect(failure.message).toMatch(/still here/);
  });

  it('separates a timeout from an outage', () => {
    const failure = toFailure(new NetworkError(true));
    expect(failure).toMatchObject({ kind: 'timeout', retryable: true });
    expect(failure.message).toMatch(/too long/);
  });

  it('carries field messages for validation errors and does not offer a retry', () => {
    const failure = toFailure(new ApiError(400, 'Validation failed', { title: ['Too long'] }));
    expect(failure).toMatchObject({
      kind: 'validation',
      retryable: false,
      fieldErrors: { title: ['Too long'] },
    });
  });

  it('flags a stale record so the form offers a reload, not a retry', () => {
    const failure = toFailure(new ApiError(409, 'x', { code: 'VERSION_CONFLICT' }));
    expect(failure).toMatchObject({ kind: 'conflict', stale: true, retryable: false });
  });

  it('shows the server message for other conflicts', () => {
    const failure = toFailure(new ApiError(409, 'That name is already in use.'));
    expect(failure.message).toBe('That name is already in use.');
    expect(failure.stale).toBe(false);
  });

  it('retries 5xx and 429 but not 403 or 404', () => {
    expect(toFailure(new ApiError(503, 'x')).retryable).toBe(true);
    expect(toFailure(new ApiError(429, 'x')).retryable).toBe(true);
    expect(toFailure(new ApiError(403, 'x')).retryable).toBe(false);
    expect(toFailure(new ApiError(404, 'x')).retryable).toBe(false);
  });

  it('falls back for unknown throwables', () => {
    expect(toFailure(new Error('boom'), 'Could not save.').message).toBe('Could not save.');
  });
});
