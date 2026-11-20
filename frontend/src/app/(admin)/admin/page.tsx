import type { Metadata } from 'next';
import { Placeholder } from '@/components/Placeholder';

export const metadata: Metadata = { title: 'Admin' };

export default function AdminPage() {
  return <Placeholder title="Admin area" description="Placeholder for the admin section." />;
}
