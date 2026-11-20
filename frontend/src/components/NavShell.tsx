import Link from 'next/link';
import type { ReactNode } from 'react';

const links = [
  { href: '/login', label: 'Sign in' },
  { href: '/employee', label: 'Employee' },
  { href: '/technician', label: 'Technician' },
  { href: '/admin', label: 'Admin' },
];

export function NavShell({ children }: { children: ReactNode }) {
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
          <ul className="flex flex-wrap gap-3 text-sm">
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="rounded px-2 py-1 hover:bg-slate-100">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        {children}
      </main>
    </>
  );
}
