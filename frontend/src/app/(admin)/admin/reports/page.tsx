import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReportsDashboard } from '@/components/reports/ReportsDashboard';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Reports' };

export default function AdminReportsPage() {
  return (
    <section aria-labelledby="page-title">
      <PageHeader
        eyebrow="Administration"
        title="Reports"
        description="Routing, response and resolution times, AI accuracy and ticket volume for a UTC date range."
      />
      <Suspense
        fallback={
          <p role="status" className="mt-6 text-slate-600">
            Loading…
          </p>
        }
      >
        <ReportsDashboard />
      </Suspense>
    </section>
  );
}
