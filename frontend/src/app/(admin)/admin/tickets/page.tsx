import type { Metadata } from 'next';
import { TicketList } from '@/components/tickets/TicketList';

export const metadata: Metadata = { title: 'Tickets' };

export default function AdminTicketsPage() {
  return <TicketList admin />;
}
