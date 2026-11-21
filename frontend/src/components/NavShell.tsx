'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { portalFor, ROLE_LABEL } from '@/lib/auth/roles';

export function NavShell({ children }: { children: ReactNode }) {
  const { status, user, signOut } = useAuth();
  const router = useRouter();

  async function onSignOut() {
    await signOut();
    router.replace('/login');
  }

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-slate-200 bg-white">
        <nav
          aria-label="Main"
          className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3"
        >
          <Link href="/" className="font-semibold">
            SmartDesk
          </Link>
          <ul className="flex flex-wrap items-center gap-3 text-sm">
            {user ? (
              <>
                <li>
                  <Link
                    href={portalFor(user.role)}
                    className="rounded px-2 py-1 hover:bg-slate-100"
                  >
                    {user.role === 'EMPLOYEE' ? 'My tickets' : ROLE_LABEL[user.role]}
                  </Link>
                </li>
                {user.role === 'EMPLOYEE' && (
                  <li>
                    <Link
                      href="/employee/tickets/new"
                      className="rounded px-2 py-1 hover:bg-slate-100"
                    >
                      New ticket
                    </Link>
                  </li>
                )}
              </>
            ) : (
              status !== 'loading' && (
                <li>
                  <Link href="/login" className="rounded px-2 py-1 hover:bg-slate-100">
                    Sign in
                  </Link>
                </li>
              )
            )}
          </ul>
          {user && (
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span data-testid="current-user">{user.displayName}</span>
              <button
                type="button"
                onClick={onSignOut}
                className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
              >
                Sign out
              </button>
            </div>
          )}
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        {children}
      </main>
    </>
  );
}
