'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { defaultRange, isDay, rangeProblem, type DayRange } from './range';

const STORAGE_KEY = 'smartdesk.reports.range';

function remembered(): DayRange | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as DayRange | null;
    return parsed && isDay(parsed.from) && isDay(parsed.to) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The applied UTC day range for an administrator report page. It lives in the URL
 * (`?from=&to=`), is remembered for the browser session, and falls back to the last 30 days.
 */
export function useReportRange() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const urlFrom = params.get('from');
  const urlTo = params.get('to');
  const hasUrl = isDay(urlFrom) && isDay(urlTo);
  const [fallback] = useState<DayRange>(() => remembered() ?? defaultRange());
  const from = hasUrl ? urlFrom : fallback.from;
  const to = hasUrl ? urlTo : fallback.to;

  const [draft, setDraft] = useState<DayRange>({ from, to });
  const problem = rangeProblem(draft);
  const appliedProblem = rangeProblem({ from, to });

  useEffect(() => {
    if (!hasUrl) router.replace(`${pathname}?from=${from}&to=${to}`);
  }, [hasUrl, router, pathname, from, to]);

  useEffect(() => {
    setDraft({ from, to });
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ from, to }));
    } catch {
      /* remembering the range is a convenience only */
    }
  }, [from, to]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    router.push(`${pathname}?from=${draft.from}&to=${draft.to}`);
  };

  return { from, to, draft, setDraft, problem, appliedProblem, apply };
}
