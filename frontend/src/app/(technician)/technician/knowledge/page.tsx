import type { Metadata } from 'next';
import { Suspense } from 'react';
import { KnowledgeSearch } from '@/components/knowledge/KnowledgeSearch';

export const metadata: Metadata = { title: 'Knowledge base' };

export default function KnowledgePage() {
  // useSearchParams (query, category, page) needs a Suspense boundary.
  return (
    <Suspense
      fallback={
        <p role="status" className="text-muted">
          Loading…
        </p>
      }
    >
      <KnowledgeSearch basePath="/technician/knowledge" />
    </Suspense>
  );
}
