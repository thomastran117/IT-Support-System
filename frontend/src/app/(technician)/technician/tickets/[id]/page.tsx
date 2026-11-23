import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TriageDetail } from '@/components/technician/TriageDetail';
import { LoadingState } from '@/components/ui';

export const metadata: Metadata = { title: 'Triage ticket' };

export default function TriagePage() {
  return (
    <Suspense fallback={<LoadingState label="Loading ticket" />}>
      <TriageDetail />
    </Suspense>
  );
}
