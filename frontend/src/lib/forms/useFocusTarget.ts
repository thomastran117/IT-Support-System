'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Moves keyboard focus to an element on demand (typically the error summary after a failed
 * submit). Calling `focus()` repeatedly re-focuses even when the target did not change.
 */
export function useFocusTarget<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (request > 0) ref.current?.focus();
  }, [request]);
  const focus = useCallback(() => setRequest((n) => n + 1), []);
  return { ref, focus };
}
