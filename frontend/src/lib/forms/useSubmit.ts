'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toFailure, type Failure } from './failure';

export type SubmitResult<T> = { ok: true; value: T } | { ok: false; failure: Failure };

/**
 * Runs one submission at a time and records the outcome. It never touches form state, so whatever
 * the user typed survives a failure and can be sent again with `retry`.
 */
export function useSubmit() {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const inFlight = useRef(false);
  const last = useRef<{ work: () => Promise<unknown>; fallback?: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async <T>(work: () => Promise<T>, fallback?: string): Promise<SubmitResult<T> | null> => {
      if (inFlight.current) return null; // a double click must not send twice
      inFlight.current = true;
      last.current = { work, fallback };
      setPending(true);
      setFailure(null);
      try {
        return { ok: true, value: await work() };
      } catch (err) {
        const failed = toFailure(err, fallback);
        if (mounted.current) setFailure(failed);
        return { ok: false, failure: failed };
      } finally {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      }
    },
    [],
  );

  const retry = useCallback(
    () => (last.current ? run(last.current.work, last.current.fallback) : Promise.resolve(null)),
    [run],
  );
  const clear = useCallback(() => setFailure(null), []);

  return { pending, failure, run, retry, clear };
}
