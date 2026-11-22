import { ApiError, NetworkError, errorKind, type ApiErrorKind } from '@/lib/auth/client';

/** A failed request, reduced to what a form needs to show and act on. */
export interface Failure {
  kind: ApiErrorKind;
  /** Safe to show to the user. */
  message: string;
  /** Per-field messages when the server rejected specific inputs. */
  fieldErrors: Record<string, string[]>;
  /** The same request may succeed if repeated unchanged (outage, timeout, overload). */
  retryable: boolean;
  /** The record changed since it was loaded (409 `VERSION_CONFLICT`): reload instead of retrying. */
  stale: boolean;
}

const RETRYABLE: ReadonlySet<ApiErrorKind> = new Set([
  'network',
  'timeout',
  'server',
  'rate_limited',
]);

/**
 * One mapping from any thrown value to user-facing feedback, so every form says the same thing
 * about the same failure. Typed input is never part of this: callers keep their own state.
 */
export function toFailure(
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
): Failure {
  const kind = errorKind(err);
  const base = { kind, fieldErrors: {}, retryable: RETRYABLE.has(kind), stale: false };
  if (err instanceof NetworkError) {
    return {
      ...base,
      message: err.timedOut
        ? 'The server took too long to respond. Your changes are still here; try again.'
        : 'Unable to reach the server. Your changes are still here; try again.',
    };
  }
  if (err instanceof ApiError) {
    if (err.isVersionConflict) {
      return {
        ...base,
        stale: true,
        message: 'Someone else changed this record. Reload it to see the latest version.',
      };
    }
    switch (err.kind) {
      case 'validation':
        return {
          ...base,
          fieldErrors: err.fieldErrors,
          message: 'Check the highlighted fields and try again.',
        };
      case 'forbidden':
        return { ...base, message: 'You do not have permission to do this.' };
      case 'not_found':
        return { ...base, message: 'This item no longer exists.' };
      case 'rate_limited':
        return { ...base, message: 'Too many requests. Wait a moment and try again.' };
      case 'server':
        return {
          ...base,
          message: 'The server hit a problem. Your changes are still here; try again.',
        };
      case 'conflict':
        return { ...base, message: err.message || fallback };
      default:
        return { ...base, message: fallback };
    }
  }
  return { ...base, message: fallback };
}
