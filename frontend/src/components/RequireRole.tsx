'use client';

import type { Role } from '@smartdesk/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { portalFor } from '@/lib/auth/roles';

/**
 * Client-side route guard for a portal. It only improves the experience (no flash of forbidden
 * content, correct redirects); the API enforces authorization independently.
 *  - anonymous  -> /login
 *  - wrong role -> that user's own portal
 */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { status, user } = useAuth();
  const router = useRouter();

  const target =
    status === 'anonymous' ? '/login' : user && user.role !== role ? portalFor(user.role) : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (status !== 'authenticated' || target) {
    return (
      <p role="status" className="app-card mx-auto max-w-xl p-6 text-slate-600">
        Checking your session…
      </p>
    );
  }
  return <>{children}</>;
}
