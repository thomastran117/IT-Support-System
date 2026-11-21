import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ArticleEditor } from '@/components/knowledge/ArticleEditor';

export const metadata: Metadata = { title: 'Edit article' };

export default function ArticleEditorPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-slate-600">
          Loading…
        </p>
      }
    >
      <ArticleEditor />
    </Suspense>
  );
}
