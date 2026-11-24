'use client';

import type {
  CategoryRefDto,
  KnowledgeArticleSummaryDto,
  KnowledgeSearchResultDto,
} from '@smartdesk/contracts';
import { BookOpen, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { ApiError, NetworkError } from '@/lib/auth/client';
import { useAuth } from '@/lib/auth/AuthProvider';
import { knowledgeApi } from '@/lib/knowledge/api';
import { formatDateTime } from '@/lib/tickets/format';
import { inputClass, primaryButton, secondaryButton } from '../tickets/ui';

const PAGE_SIZE = 10;
const QUERY_MAX = 200;

interface Row {
  id: string;
  title: string;
  category: { id: string; name: string } | null;
  /** Search hits carry a preview; the browse list carries a last-updated time instead. */
  preview?: string;
  updatedAt?: string;
}

interface Result {
  rows: Row[];
  total: number;
  nextOffset: number | null;
  offset: number;
}

function describeError(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'Unable to reach the server. Check your connection and try again.';
  }
  if (err instanceof ApiError) {
    if (err.status === 400) return 'That search was not accepted. Shorten it and try again.';
    if (err.status === 403) return 'You do not have access to the knowledge base.';
    if (err.status === 429) return 'Too many requests. Please wait a moment and try again.';
  }
  return 'Unable to load articles. Please try again.';
}

/**
 * Search and browse published articles. The query, category and page live in the URL, so the
 * browser back button, reloads and shared links all return to the same results. What a reader may
 * see is decided by the API; nothing here filters drafts.
 *
 * `basePath` is the portal this page lives in (e.g. `/employee/knowledge`), used for result links.
 */
export function KnowledgeSearch({ basePath }: { basePath: string }) {
  const { api } = useAuth();
  const kb = useMemo(() => knowledgeApi(api), [api]);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const q = (params.get('q') ?? '').slice(0, QUERY_MAX);
  const categoryId = params.get('category') ?? '';
  const pageNumber = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const offset = (pageNumber - 1) * PAGE_SIZE;

  const [text, setText] = useState(q);
  const [categories, setCategories] = useState<CategoryRefDto[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);

  // Keep the box in step with the URL (back/forward, links), without fighting the user's typing.
  useEffect(() => setText(q), [q]);

  useEffect(() => {
    let cancelled = false;
    void kb
      .categories()
      .then((c) => !cancelled && setCategories(c))
      .catch(() => undefined); // the filter is optional; search still works without it
    return () => {
      cancelled = true;
    };
  }, [kb]);

  useEffect(() => {
    const request = ++latest.current;
    setLoading(true);
    const filter = categoryId ? { categoryId } : {};
    const run = async (): Promise<Result> => {
      if (q.trim()) {
        const page = await kb.search({ q, ...filter, limit: PAGE_SIZE, offset });
        return {
          rows: page.items.map((i: KnowledgeSearchResultDto) => i),
          total: page.total,
          nextOffset: page.nextOffset,
          offset: page.offset,
        };
      }
      const page = await kb.list({ ...filter, limit: PAGE_SIZE, offset });
      return {
        rows: page.items.map((i: KnowledgeArticleSummaryDto) => i),
        total: page.total,
        nextOffset: page.nextOffset,
        offset: page.offset,
      };
    };
    run()
      .then((r) => {
        if (request !== latest.current) return; // a newer search superseded this one
        setResult(r);
        setError(null);
      })
      .catch((err: unknown) => {
        if (request !== latest.current) return;
        setResult(null);
        setError(describeError(err));
      })
      .finally(() => {
        if (request === latest.current) setLoading(false);
      });
  }, [kb, q, categoryId, offset, reloads]);

  function go(next: { q?: string; category?: string; page?: number }) {
    const out = new URLSearchParams();
    const nq = (next.q ?? q).trim();
    const nc = next.category ?? categoryId;
    if (nq) out.set('q', nq);
    if (nc) out.set('category', nc);
    if (next.page && next.page > 1) out.set('page', String(next.page));
    const qs = out.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault(); // Enter in the box submits the form
    go({ q: text, page: 1 });
  }

  const pageHref = (page: number) => {
    const out = new URLSearchParams(params.toString());
    if (page > 1) out.set('page', String(page));
    else out.delete('page');
    const qs = out.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const searching = q.trim() !== '';
  const first = result && result.rows.length > 0 ? result.offset + 1 : 0;
  const last = result ? result.offset + result.rows.length : 0;
  const categoryName = categories.find((c) => c.id === categoryId)?.name;

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <PageHeader
        title="Knowledge base"
        description="Find step-by-step fixes for common problems before you raise a ticket."
      />

      <form role="search" onSubmit={onSubmit} className="app-card p-4 sm:p-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem_auto] md:items-end">
          <div>
            <label htmlFor="kb-q" className="mb-1.5 block text-sm font-semibold text-ink">
              Search articles
            </label>
            <input
              id="kb-q"
              name="q"
              type="search"
              value={text}
              maxLength={QUERY_MAX}
              autoComplete="off"
              placeholder="For example: VPN keeps disconnecting"
              onChange={(e) => setText(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="kb-category" className="mb-1.5 block text-sm font-semibold text-ink">
              Category
            </label>
            <select
              id="kb-category"
              value={categoryId}
              onChange={(e) => go({ category: e.target.value, page: 1 })}
              className={inputClass}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={primaryButton}>
            <Search aria-hidden="true" size={16} />
            Search
          </button>
        </div>
      </form>

      <div aria-live="polite" className="text-sm text-muted" data-testid="result-summary">
        {!loading && result && result.total > 0
          ? searching
            ? `Showing ${first}–${last} of ${result.total} results for “${q}”${
                categoryName ? ` in ${categoryName}` : ''
              }`
            : `Showing ${first}–${last} of ${result.total} articles${
                categoryName ? ` in ${categoryName}` : ''
              }`
          : null}
      </div>

      {loading && !result && !error ? (
        <LoadingState label="Loading articles" />
      ) : error ? (
        <ErrorState
          message={error}
          action={
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setReloads((n) => n + 1)}
            >
              Try again
            </button>
          }
        />
      ) : result && result.rows.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={searching ? 'No articles match your search' : 'No articles yet'}
          description={
            searching
              ? 'Check the spelling, try fewer or different words, or choose another category.'
              : 'Published help articles will appear here.'
          }
          action={
            searching || categoryId ? (
              <Link href={pathname} className={secondaryButton}>
                Clear search
              </Link>
            ) : undefined
          }
        />
      ) : (
        result && (
          <>
            <ul
              aria-label="Articles"
              aria-busy={loading}
              className={`grid gap-4 ${loading ? 'opacity-60' : ''}`}
            >
              {result.rows.map((row) => (
                <li key={row.id} className="app-card p-5">
                  <h2 className="text-lg font-bold text-ink-strong">
                    <Link
                      href={`${basePath}/${row.id}`}
                      className="underline-offset-4 hover:text-accent hover:underline"
                    >
                      {row.title}
                    </Link>
                  </h2>
                  {row.preview && <p className="mt-2 text-muted-strong">{row.preview}</p>}
                  <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    {row.category && (
                      <span className="rounded-full border border-line bg-panel-hover px-2.5 py-0.5 font-semibold text-muted-strong">
                        {row.category.name}
                      </span>
                    )}
                    {row.updatedAt && <span>Updated {formatDateTime(row.updatedAt)}</span>}
                  </p>
                </li>
              ))}
            </ul>

            {(pageNumber > 1 || result.nextOffset !== null) && (
              <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
                {pageNumber > 1 ? (
                  <Link href={pageHref(pageNumber - 1)} className={secondaryButton} rel="prev">
                    Previous
                  </Link>
                ) : (
                  <span />
                )}
                {result.nextOffset !== null && (
                  <Link href={pageHref(pageNumber + 1)} className={secondaryButton} rel="next">
                    Next
                  </Link>
                )}
              </nav>
            )}
          </>
        )
      )}
    </section>
  );
}
