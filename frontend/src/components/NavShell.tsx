'use client';

import type { Role } from '@smartdesk/contracts';
import {
  BookOpen,
  BarChart3,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  PlusCircle,
  Tags,
  TicketCheck,
  Users,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ROLE_LABEL } from '@/lib/auth/roles';
import {
  NotificationBell,
  NotificationPanel,
  useNotificationCentre,
} from './notifications/NotificationCentre';
import { Avatar, BrandMark, cx } from './ui';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  active: (path: string) => boolean;
}

const NAVIGATION: Record<Role, NavItem[]> = {
  EMPLOYEE: [
    {
      href: '/employee',
      label: 'My tickets',
      icon: TicketCheck,
      active: (path) =>
        path === '/employee' || (/^\/employee\/tickets\//.test(path) && !path.endsWith('/new')),
    },
    {
      href: '/employee/tickets/new',
      label: 'New ticket',
      icon: PlusCircle,
      active: (path) => path === '/employee/tickets/new',
    },
    {
      href: '/employee/knowledge',
      label: 'Knowledge base',
      icon: BookOpen,
      active: (path) => path.startsWith('/employee/knowledge'),
    },
  ],
  TECHNICIAN: [
    {
      href: '/technician',
      label: 'Support queue',
      icon: LayoutDashboard,
      active: (path) => path.startsWith('/technician') && !path.startsWith('/technician/knowledge'),
    },
    {
      href: '/technician/knowledge',
      label: 'Knowledge base',
      icon: BookOpen,
      active: (path) => path.startsWith('/technician/knowledge'),
    },
  ],
  ADMIN: [
    {
      href: '/admin',
      label: 'User management',
      icon: UsersRound,
      active: (path) =>
        path.startsWith('/admin') &&
        !path.startsWith('/admin/knowledge') &&
        !path.startsWith('/admin/reports') &&
        !path.startsWith('/admin/categories') &&
        !path.startsWith('/admin/teams') &&
        !path.startsWith('/admin/tickets') &&
        !path.startsWith('/admin/evaluation'),
    },
    {
      href: '/admin/tickets',
      label: 'Tickets',
      icon: TicketCheck,
      active: (path) => path.startsWith('/admin/tickets'),
    },
    {
      href: '/admin/categories',
      label: 'Categories',
      icon: Tags,
      active: (path) => path.startsWith('/admin/categories'),
    },
    {
      href: '/admin/teams',
      label: 'Support teams',
      icon: Users,
      active: (path) => path.startsWith('/admin/teams'),
    },
    {
      href: '/admin/reports',
      label: 'Reports',
      icon: BarChart3,
      active: (path) => path.startsWith('/admin/reports'),
    },
    {
      href: '/admin/evaluation',
      label: 'AI evaluation',
      icon: FlaskConical,
      active: (path) => path.startsWith('/admin/evaluation'),
    },
    {
      href: '/admin/knowledge',
      label: 'Knowledge base',
      icon: BookOpen,
      active: (path) => path.startsWith('/admin/knowledge'),
    },
  ],
};

function Navigation({ role, onNavigate }: { role: Role; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-1.5">
      {NAVIGATION[role].map((item) => {
        const active = item.active(pathname);
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium',
                active
                  ? 'bg-white/12 text-white shadow-sm ring-1 ring-white/10'
                  : 'text-slate-300 hover:bg-white/7 hover:text-white',
              )}
            >
              <Icon aria-hidden="true" size={18} />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function UserPanel({ name, role, onSignOut }: { name: string; role: Role; onSignOut: () => void }) {
  return (
    <div className="border-t border-white/10 pt-4">
      <div className="flex items-center gap-3 px-1">
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <p data-testid="current-user" className="truncate text-sm font-semibold text-white">
            {name}
          </p>
          <p className="truncate text-xs text-slate-300">{ROLE_LABEL[role]}</p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <LogOut aria-hidden="true" size={17} />
        </button>
      </div>
    </div>
  );
}

export function NavShell({ children }: { children: ReactNode }) {
  const { status, user, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  // Notifications are for employees (ticket requesters); one shared state feeds both layouts.
  const centre = useNotificationCentre(user?.role === 'EMPLOYEE');

  async function onSignOut() {
    setOpen(false);
    await signOut();
    router.replace('/login');
  }

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        menuRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const skipLink = (
    <a
      href="#main"
      className="sr-only z-[100] focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:font-semibold focus:text-blue-800 focus:shadow-xl"
    >
      Skip to content
    </a>
  );

  if (!user) {
    return (
      <>
        {skipLink}
        <main id="main" className="min-h-screen">
          {children}
        </main>
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f7fb] lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      {skipLink}
      <aside className="sticky top-0 hidden h-screen flex-col overflow-y-auto bg-[#0b1f3a] px-4 py-5 text-white lg:flex">
        <div className="flex items-center justify-between gap-2">
          <Link href={NAVIGATION[user.role][0].href} className="px-2">
            <BrandMark />
            <span className="sr-only"> home</span>
          </Link>
          {user.role === 'EMPLOYEE' && (
            <NotificationBell
              centre={centre}
              className="text-slate-300 hover:bg-white/10 hover:text-white"
            />
          )}
        </div>
        <p className="mt-8 px-3 text-[0.7rem] font-bold tracking-[0.14em] text-slate-300 uppercase">
          Workspace
        </p>
        <nav aria-label="Main" className="mt-3">
          <Navigation role={user.role} />
        </nav>
        <div className="mt-auto pt-8">
          <div className="mb-5 rounded-xl border border-white/8 bg-white/5 p-3">
            <p className="text-xs font-semibold text-slate-300">IT support, organized.</p>
            <p className="mt-1 text-xs leading-5 text-slate-300">
              Track every request from first report to resolution.
            </p>
          </div>
          <UserPanel name={user.displayName} role={user.role} onSignOut={() => void onSignOut()} />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200/90 bg-white/95 px-4 backdrop-blur lg:hidden">
          <Link href={NAVIGATION[user.role][0].href}>
            <BrandMark />
            <span className="sr-only"> home</span>
          </Link>
          <div className="flex items-center gap-2">
            {user.role === 'EMPLOYEE' && (
              <NotificationBell
                centre={centre}
                className="border border-slate-200 bg-white text-slate-700 shadow-sm"
              />
            )}
            <button
              ref={menuRef}
              type="button"
              aria-label="Open navigation"
              aria-expanded={open}
              aria-controls="mobile-navigation"
              onClick={() => setOpen(true)}
              className="grid size-10 place-items-center rounded-lg border border-slate-200 bg-white text-slate-700 shadow-sm"
            >
              <Menu aria-hidden="true" size={20} />
            </button>
          </div>
        </header>
        {user.role === 'EMPLOYEE' && <NotificationPanel centre={centre} />}

        {open && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]"
              onClick={() => setOpen(false)}
            />
            <div
              id="mobile-navigation"
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="absolute inset-y-0 left-0 flex w-[min(19rem,88vw)] flex-col bg-[#0b1f3a] p-5 text-white shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <BrandMark />
                <button
                  ref={closeRef}
                  type="button"
                  aria-label="Close navigation"
                  onClick={() => {
                    setOpen(false);
                    menuRef.current?.focus();
                  }}
                  className="grid size-10 place-items-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white"
                >
                  <X aria-hidden="true" size={21} />
                </button>
              </div>
              <p className="mt-8 px-3 text-[0.7rem] font-bold tracking-[0.14em] text-slate-300 uppercase">
                Workspace
              </p>
              <nav aria-label="Main" className="mt-3">
                <Navigation role={user.role} onNavigate={() => setOpen(false)} />
              </nav>
              <div className="mt-auto">
                <UserPanel
                  name={user.displayName}
                  role={user.role}
                  onSignOut={() => void onSignOut()}
                />
              </div>
            </div>
          </div>
        )}

        <main id="main" className="mx-auto w-full max-w-[90rem] px-4 py-7 sm:px-6 sm:py-9 xl:px-10">
          {status === 'loading' ? null : children}
        </main>
      </div>
    </div>
  );
}
