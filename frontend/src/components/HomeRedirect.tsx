'use client';

import { LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { portalFor } from '@/lib/auth/roles';
import { BrandMark } from './ui';

export function HomeRedirect() {
  const { status, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
    if (status === 'authenticated' && user) router.replace(portalFor(user.role));
  }, [status, user, router]);

  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <div className="text-center">
        <BrandMark />
        <p role="status" className="mt-6 inline-flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" size={17} className="animate-spin" />
          Opening your workspace…
        </p>
      </div>
    </div>
  );
}
