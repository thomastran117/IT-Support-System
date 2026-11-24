import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ArticleEditor } from '@/components/knowledge/ArticleEditor';

export const metadata: Metadata = { title: 'New article' };

export default function ArticleEditorPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-muted">
          Loading…
        </p>
      }
    >
      <ArticleEditor />
    </Suspense>
  );
}
