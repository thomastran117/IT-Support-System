import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TicketDetail } from '@/components/tickets/TicketDetail';

export const metadata: Metadata = { title: 'Ticket' };

export default function TicketPage() {
  // useSearchParams (the "just submitted" banner) needs a Suspense boundary.
  return (
    <Suspense
      fallback={
        <p role="status" className="text-slate-600">
          Loading ticket…
        </p>
      }
    >
      <TicketDetail />
    </Suspense>
  );
}
