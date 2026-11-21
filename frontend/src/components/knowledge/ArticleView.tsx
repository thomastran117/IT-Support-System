'use client';

import type { KnowledgeArticleDto } from '@smartdesk/contracts';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { ApiError, NetworkError } from '@/lib/auth/client';
import { useAuth } from '@/lib/auth/AuthProvider';
import { knowledgeApi } from '@/lib/knowledge/api';
import { formatDateTime } from '@/lib/tickets/format';
import { secondaryButton } from '../tickets/ui';
import { ArticleBody } from './ArticleBody';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; article: KnowledgeArticleDto }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/**
 * One published article. Drafts, unpublished, deleted and malformed ids all come back from the API
 * as 404 (or 400), and all show the same "not available" page: the UI never says which it was.
 */
export function ArticleView({ backHref }: { backHref: string }) {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();
  const kb = useMemo(() => knowledgeApi(api), [api]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    kb.get(id).then(
      (article) => !cancelled && setState({ kind: 'ready', article }),
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
          setState({ kind: 'missing' });
        } else if (err instanceof NetworkError) {
          setState({ kind: 'error', message: 'Unable to reach the server. Please try again.' });
        } else {
          setState({ kind: 'error', message: 'Unable to load this article. Please try again.' });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kb, id, attempt]);

  const back = (
    <Link href={backHref} className={secondaryButton}>
      <ArrowLeft aria-hidden="true" size={16} />
      Back to knowledge base
    </Link>
  );

  if (state.kind === 'loading') return <LoadingState label="Loading article" />;

  if (state.kind === 'missing') {
    return (
      <section aria-labelledby="page-title" className="space-y-6">
        <h1 id="page-title" className="sr-only">
          Article not available
        </h1>
        <EmptyState
          icon={FileQuestion}
          title="This article is not available"
          description="It may have been withdrawn or the link may be wrong. Try searching for it instead."
          action={back}
        />
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <ErrorState
        message={state.message}
        action={
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        }
      />
    );
  }

  const { article } = state;
  return (
    <article aria-labelledby="page-title" className="space-y-6">
      <PageHeader
        eyebrow={article.category?.name ?? 'Help article'}
        title={article.title}
        description={`Last updated ${formatDateTime(article.updatedAt)}`}
        actions={back}
      />
      <div className="app-card max-w-3xl p-6 sm:p-8">
        <ArticleBody text={article.body} />
      </div>
    </article>
  );
}
