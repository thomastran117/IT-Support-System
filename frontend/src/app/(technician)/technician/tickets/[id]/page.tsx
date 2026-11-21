import type { Metadata } from 'next';
import { TriageDetail } from '@/components/technician/TriageDetail';

export const metadata: Metadata = { title: 'Triage ticket' };

export default function TriagePage() {
  return <TriageDetail />;
}
