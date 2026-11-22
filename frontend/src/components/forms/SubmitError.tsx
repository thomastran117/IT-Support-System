import { Notice, buttonClass } from '@/components/ui';
import type { Failure } from '@/lib/forms/failure';

/**
 * Announces a failed submission and, when sending it again could work, offers the retry. The form
 * keeps its input, so "Try again" resends exactly what is on screen.
 */
export function SubmitError({
  failure,
  onRetry,
  onReload,
  retrying = false,
}: {
  failure: Failure | null;
  onRetry?: () => void;
  /** Offered for a stale record (409): reload the latest version. */
  onReload?: () => void;
  retrying?: boolean;
}) {
  if (!failure) return null;
  const canRetry = failure.retryable && onRetry;
  const canReload = failure.stale && onReload;
  return (
    <Notice tone="danger" role="alert">
      <p>{failure.message}</p>
      {(canRetry || canReload) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canRetry && (
            <button
              type="button"
              className={buttonClass('secondary')}
              disabled={retrying}
              onClick={onRetry}
            >
              Try again
            </button>
          )}
          {canReload && (
            <button type="button" className={buttonClass('secondary')} onClick={onReload}>
              Reload latest
            </button>
          )}
        </div>
      )}
    </Notice>
  );
}
