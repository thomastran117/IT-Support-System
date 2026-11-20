import type { Metadata } from 'next';
import { Placeholder } from '@/components/Placeholder';

export const metadata: Metadata = { title: 'Employee' };

export default function EmployeePage() {
  return <Placeholder title="Employee area" description="Placeholder for the employee section." />;
}
