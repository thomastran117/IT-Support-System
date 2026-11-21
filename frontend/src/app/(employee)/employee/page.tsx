import type { Metadata } from 'next';
import { TicketList } from '@/components/tickets/TicketList';

export const metadata: Metadata = { title: 'My tickets' };

export default function EmployeePage() {
  return <TicketList />;
}
