import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TriageDetail } from '@/components/technician/TriageDetail';
import { LoadingState } from '@/components/ui';

export const metadata: Metadata = { title: 'Ticket' };

export default function AdminTicketPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading ticket" />}>
      <TriageDetail admin />
    </Suspense>
  );
}
