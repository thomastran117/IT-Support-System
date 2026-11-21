import type { Metadata } from 'next';
import { Suspense } from 'react';
import { KnowledgeAdmin } from '@/components/knowledge/KnowledgeAdmin';

export const metadata: Metadata = { title: 'Knowledge articles' };

export default function AdminKnowledgePage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-slate-600">
          Loading…
        </p>
      }
    >
      <KnowledgeAdmin />
    </Suspense>
  );
}
