import type { Metadata } from 'next';
import { TechnicianDashboard } from '@/components/technician/TechnicianDashboard';

export const metadata: Metadata = { title: 'Technician dashboard' };

export default function TechnicianPage() {
  return <TechnicianDashboard />;
}
