'use client';

import {
  ARTICLE_BODY_MAX,
  ARTICLE_TITLE_MAX,
  createArticleSchema,
  type AdminKnowledgeArticleDto,
  type CategoryRefDto,
} from '@smartdesk/contracts';
import { ArrowLeft, Eye, EyeOff, Save } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AsyncButton } from '@/components/forms/AsyncButton';
import { FormField } from '@/components/forms/FormField';
import { SubmitError } from '@/components/forms/SubmitError';
import { ErrorState, LoadingState, Notice, PageHeader } from '@/components/ui';
import { ApiError } from '@/lib/auth/client';
import { useFocusTarget } from '@/lib/forms/useFocusTarget';
import { useSubmit } from '@/lib/forms/useSubmit';
import { useAuth } from '@/lib/auth/AuthProvider';
import { knowledgeApi } from '@/lib/knowledge/api';
import { formatDateTime } from '@/lib/tickets/format';
import {
  Counter,
  ErrorSummary,
  inputClass,
  primaryButton,
  secondaryButton,
  type SummaryItem,
} from '../tickets/ui';
import { ArticleBody } from './ArticleBody';

type Confirm = 'publish' | 'unpublish' | null;

/**
 * Create or edit one article (administrators only; the API enforces that, this page merely hides
 * what would be refused). Publishing and withdrawing change what every reader sees, so each asks
 * for an explicit confirmation first, and unsaved edits must be saved before either.
 */
export function ArticleEditor() {
  const { id } = useParams<{ id?: string }>();
  const isNew = id === undefined;
  const { api } = useAuth();
  const kb = useMemo(() => knowledgeApi(api), [api]);
  const router = useRouter();
  const justCreated = useSearchParams().get('created') === '1';
  const { ref: summaryRef, focus: focusSummary } = useFocusTarget<HTMLDivElement>();
  const { pending: busy, failure, run, retry, clear } = useSubmit();

  const [loaded, setLoaded] = useState<AdminKnowledgeArticleDto | null>(null);
  const [categories, setCategories] = useState<CategoryRefDto[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    isNew ? 'ready' : 'loading',
  );
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [errors, setErrors] = useState<SummaryItem[]>([]);
  const [message, setMessage] = useState<string | null>(
    justCreated ? 'Draft saved. Publish it when it is ready.' : null,
  );
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [attempt, setAttempt] = useState(0);

  const adopt = (article: AdminKnowledgeArticleDto) => {
    setLoaded(article);
    setTitle(article.title);
    setBody(article.body);
    setCategoryId(article.category?.id ?? '');
  };

  useEffect(() => {
    let cancelled = false;
    void kb
      .allCategories()
      .then((c) => !cancelled && setCategories(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [kb]);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    setStatus('loading');
    kb.adminGet(id).then(
      (article) => {
        if (cancelled) return;
        adopt(article);
        setStatus('ready');
      },
      (err: unknown) => {
        if (cancelled) return;
        setStatus(err instanceof ApiError && [400, 404].includes(err.status) ? 'missing' : 'error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kb, id, isNew, attempt]);

  const dirty =
    loaded === null
      ? title !== '' || body !== '' || categoryId !== ''
      : title !== loaded.title ||
        body !== loaded.body ||
        categoryId !== (loaded.category?.id ?? '');

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    clear();
    setConfirm(null);
    const draft = { title, body, categoryId: categoryId || null };
    const parsed = createArticleSchema.safeParse(draft);
    if (!parsed.success) {
      const seen = new Set<string>();
      const items: SummaryItem[] = [];
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'title');
        if (seen.has(field)) continue;
        seen.add(field);
        items.push({
          field,
          message:
            field === 'title'
              ? `Enter a title of 1 to ${ARTICLE_TITLE_MAX} characters.`
              : field === 'body'
                ? `Enter article text of 1 to ${ARTICLE_BODY_MAX} characters.`
                : 'Choose a valid category.',
        });
      }
      setErrors(items);
      focusSummary();
      return;
    }
    setErrors([]);
    await save(draft);
  }

  /** Sends the draft; the form keeps its values on failure so "Try again" resends them. */
  async function save(draft: { title: string; body: string; categoryId: string | null }) {
    const result = await run(async () => {
      if (isNew) {
        const created = await kb.create(draft);
        router.replace(`/admin/knowledge/${created.id}?created=1`);
        return null;
      }
      return kb.update(id, draft);
    }, 'The article could not be saved.');
    if (result?.ok && result.value) {
      adopt(result.value);
      setMessage('Changes saved.');
    }
  }

  async function change(action: 'publish' | 'unpublish') {
    if (busy || isNew) return;
    setMessage(null);
    const result = await run(
      () => (action === 'publish' ? kb.publish(id) : kb.unpublish(id)),
      'The visibility could not be changed.',
    );
    if (result?.ok) {
      adopt(result.value);
      setConfirm(null);
      setMessage(
        action === 'publish'
          ? 'Article published. Readers can now find it.'
          : 'Article withdrawn. Readers can no longer open it.',
      );
    }
  }

  if (status === 'loading') return <LoadingState label="Loading article" />;
  if (status === 'missing') {
    return (
      <ErrorState
        message="This article could not be found."
        action={
          <Link href="/admin/knowledge" className={secondaryButton}>
            Back to articles
          </Link>
        }
      />
    );
  }
  if (status === 'error') {
    return (
      <ErrorState
        message="Unable to load this article. Please try again."
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

  const published = loaded?.isPublished ?? false;
  // Categories can be deactivated after an article was filed; keep showing its current one.
  const options =
    loaded?.category && !categories.some((c) => c.id === loaded.category!.id)
      ? [...categories, { id: loaded.category.id, name: loaded.category.name, description: null }]
      : categories;

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <PageHeader
        eyebrow="Knowledge base"
        title={isNew ? 'New article' : 'Edit article'}
        description={
          isNew
            ? 'Write a draft. Nobody can see it until you publish it.'
            : `Last updated ${formatDateTime(loaded!.updatedAt)}`
        }
        actions={
          <Link href="/admin/knowledge" className={secondaryButton}>
            <ArrowLeft aria-hidden="true" size={16} />
            All articles
          </Link>
        }
      />

      {!isNew && (
        <p data-testid="publication-status" className="flex items-center gap-2 text-sm">
          <span
            className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
              published
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-slate-200 bg-slate-100 text-slate-700'
            }`}
          >
            {published ? 'Published' : 'Draft'}
          </span>
          <span className="text-slate-600">
            {published ? 'Visible to every signed-in user.' : 'Visible only to administrators.'}
          </span>
        </p>
      )}

      {message && (
        <div data-testid="notice">
          <Notice tone="success" role="status">
            {message}
          </Notice>
        </div>
      )}
      <SubmitError
        failure={failure}
        retrying={busy}
        onRetry={() => void retry()}
        onReload={() => setAttempt((n) => n + 1)}
      />
      <ErrorSummary ref={summaryRef} items={errors} />

      <form onSubmit={onSave} noValidate className="grid gap-6 xl:grid-cols-2">
        <div className="app-card space-y-5 p-5 sm:p-6">
          <FormField
            id="title"
            label="Title"
            error={errors.find((e) => e.field === 'title')?.message}
            footerId="title-count"
            footer={<Counter id="title-count" length={title.length} max={ARTICLE_TITLE_MAX} />}
          >
            {(control) => (
              <input
                {...control}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={inputClass}
              />
            )}
          </FormField>

          <div>
            <label
              htmlFor="categoryId"
              className="mb-1.5 block text-sm font-semibold text-slate-800"
            >
              Category
            </label>
            <select
              id="categoryId"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={inputClass}
            >
              <option value="">No category</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <FormField
            id="body"
            label="Article text"
            hint="Plain text. You can use # headings, - bullets, 1. numbered steps, **bold** and `code`. HTML is shown as text, never run."
            error={errors.find((e) => e.field === 'body')?.message}
            footerId="body-count"
            footer={<Counter id="body-count" length={body.length} max={ARTICLE_BODY_MAX} />}
          >
            {(control) => (
              <textarea
                {...control}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={14}
                className={`${inputClass} font-mono text-sm`}
              />
            )}
          </FormField>

          <div className="flex flex-wrap items-center gap-3">
            <AsyncButton pending={busy} pendingLabel="Saving…">
              <Save aria-hidden="true" size={16} />
              {isNew ? 'Save draft' : 'Save changes'}
            </AsyncButton>
            {!isNew && dirty && (
              <span className="text-sm text-amber-800">You have unsaved changes.</span>
            )}
          </div>

          {!isNew && (
            <div className="border-t border-slate-200 pt-5">
              <h2 className="text-base font-bold text-slate-950">Visibility</h2>
              {confirm === null ? (
                <div className="mt-3">
                  {published ? (
                    <button
                      type="button"
                      disabled={busy || dirty}
                      onClick={() => setConfirm('unpublish')}
                      className={secondaryButton}
                    >
                      <EyeOff aria-hidden="true" size={16} />
                      Unpublish
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || dirty}
                      onClick={() => setConfirm('publish')}
                      className={secondaryButton}
                    >
                      <Eye aria-hidden="true" size={16} />
                      Publish
                    </button>
                  )}
                  {dirty && (
                    <p className="mt-2 text-sm text-slate-600">
                      Save your changes before changing visibility.
                    </p>
                  )}
                </div>
              ) : (
                <div
                  role="alertdialog"
                  aria-labelledby="confirm-title"
                  aria-describedby="confirm-text"
                  className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4"
                >
                  <p id="confirm-title" className="font-semibold text-amber-950">
                    {confirm === 'publish' ? 'Publish this article?' : 'Unpublish this article?'}
                  </p>
                  <p id="confirm-text" className="mt-1 text-sm text-amber-950">
                    {confirm === 'publish'
                      ? 'Every signed-in user will be able to find and read it.'
                      : 'Readers will no longer find or open it. Past ticket recommendations keep their link.'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      autoFocus
                      disabled={busy}
                      onClick={() => void change(confirm)}
                      className={primaryButton}
                    >
                      {confirm === 'publish' ? 'Yes, publish' : 'Yes, unpublish'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm(null)}
                      className={secondaryButton}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="app-card p-5 sm:p-6">
          <h2 className="text-base font-bold text-slate-950">Preview</h2>
          <p className="mt-1 mb-4 text-sm text-slate-600">How readers will see the text.</p>
          {body.trim() ? (
            <ArticleBody text={body} />
          ) : (
            <p className="text-sm text-slate-500">Nothing to preview yet.</p>
          )}
        </div>
      </form>
    </section>
  );
}
