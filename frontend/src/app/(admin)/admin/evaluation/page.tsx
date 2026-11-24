import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AiEvaluation } from '@/components/reports/AiEvaluation';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'AI evaluation' };

export default function AdminEvaluationPage() {
  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="AI evaluation"
        description="How often the AI category recommendation matches an independent label, and how often technicians accept it."
      />
      <Suspense
        fallback={
          <p role="status" className="mt-6 text-muted">
            Loading…
          </p>
        }
      >
        <AiEvaluation />
      </Suspense>
    </section>
  );
}
