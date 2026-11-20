import type { Metadata } from 'next';
import { Placeholder } from '@/components/Placeholder';

export const metadata: Metadata = { title: 'Technician' };

export default function TechnicianPage() {
  return (
    <Placeholder title="Technician area" description="Placeholder for the technician section." />
  );
}
