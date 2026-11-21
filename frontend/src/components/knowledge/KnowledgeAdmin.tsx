'use client';

import type { AdminKnowledgeArticleSummaryDto } from '@smartdesk/contracts';
import { BookOpen, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth/AuthProvider';
import { knowledgeApi } from '@/lib/knowledge/api';
import { formatDateTime } from '@/lib/tickets/format';
import { inputClass, primaryButton, secondaryButton } from '../tickets/ui';

const PAGE_SIZE = 20;
type Filter = 'all' | 'published' | 'draft';

/** Every article, drafts included, for administrators. Filter and page live in the URL. */
export function KnowledgeAdmin() {
  const { api } = useAuth();
  const kb = useMemo(() => knowledgeApi(api), [api]);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const raw = params.get('status');
  const filter: Filter = raw === 'published' || raw === 'draft' ? raw : 'all';
  const pageNumber = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);

  const [items, setItems] = useState<AdminKnowledgeArticleSummaryDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    kb.adminList({
      ...(filter === 'all' ? {} : { published: filter === 'published' }),
      limit: PAGE_SIZE,
      offset: (pageNumber - 1) * PAGE_SIZE,
    }).then(
      (page) => {
        if (request !== latest.current) return;
        setItems(page.items);
        setTotal(page.total);
        setNextOffset(page.nextOffset);
        setError(null);
      },
      () => {
        if (request !== latest.current) return;
        setItems(null);
        setError('Unable to load articles. Please try again.');
      },
    );
  }, [kb, filter, pageNumber, reloads]);

  const href = (next: { status?: Filter; page?: number }) => {
    const out = new URLSearchParams();
    const status = next.status ?? filter;
    if (status !== 'all') out.set('status', status);
    if (next.page && next.page > 1) out.set('page', String(next.page));
    const qs = out.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Knowledge articles"
        description="Write, publish and withdraw the help articles employees search."
        actions={
          <Link href="/admin/knowledge/new" className={primaryButton}>
            <Plus aria-hidden="true" size={16} />
            New article
          </Link>
        }
      />

      <div className="app-card p-4">
        <label
          htmlFor="status-filter"
          className="mb-1.5 block text-sm font-semibold text-slate-800"
        >
          Show
        </label>
        <select
          id="status-filter"
          value={filter}
          onChange={(e) => router.push(href({ status: e.target.value as Filter, page: 1 }))}
          className={`${inputClass} sm:max-w-xs`}
        >
          <option value="all">All articles</option>
          <option value="published">Published</option>
          <option value="draft">Drafts</option>
        </select>
      </div>

      {error ? (
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
      ) : items === null ? (
        <LoadingState label="Loading articles" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No articles here"
          description="Create an article to start the knowledge base."
        />
      ) : (
        <>
          <p className="text-sm text-slate-600">
            {total} {total === 1 ? 'article' : 'articles'}
          </p>
          <div className="app-card overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">Knowledge articles</caption>
              <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Title
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Category
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-3 font-semibold text-slate-950">
                      <Link
                        href={`/admin/knowledge/${a.id}`}
                        className="underline-offset-4 hover:text-blue-700 hover:underline"
                      >
                        {a.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{a.category?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                          a.isPublished
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border-slate-200 bg-slate-100 text-slate-700'
                        }`}
                      >
                        {a.isPublished ? 'Published' : 'Draft'}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                      {formatDateTime(a.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(pageNumber > 1 || nextOffset !== null) && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
              {pageNumber > 1 ? (
                <Link href={href({ page: pageNumber - 1 })} className={secondaryButton}>
                  Previous
                </Link>
              ) : (
                <span />
              )}
              {nextOffset !== null && (
                <Link href={href({ page: pageNumber + 1 })} className={secondaryButton}>
                  Next
                </Link>
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}
