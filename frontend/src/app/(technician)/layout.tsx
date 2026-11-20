import type { ReactNode } from 'react';
import { RequireRole } from '@/components/RequireRole';

export default function Layout({ children }: { children: ReactNode }) {
  return <RequireRole role="TECHNICIAN">{children}</RequireRole>;
}
