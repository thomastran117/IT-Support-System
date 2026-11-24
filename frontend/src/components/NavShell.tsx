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
import { ThemeSelect } from './ui/ThemeSelect';

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
    <ul className="space-y-1">
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
                'flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm',
                active
                  ? 'border-accent-line bg-accent-soft font-semibold text-accent'
                  : 'border-transparent font-medium text-muted-strong hover:bg-panel-hover hover:text-ink-strong',
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
    <div className="border-t border-line pt-4">
      <div className="flex items-center gap-2">
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <p
            data-testid="current-user"
            title={name}
            className="truncate text-sm font-semibold text-ink-strong"
          >
            {name}
          </p>
          <p className="truncate text-xs text-muted">{ROLE_LABEL[role]}</p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-strong hover:bg-panel-hover hover:text-ink-strong"
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
  const drawerRef = useRef<HTMLDialogElement>(null);
  const centre = useNotificationCentre(user?.role === 'EMPLOYEE');

  function closeNavigation() {
    drawerRef.current?.close();
    setOpen(false);
  }

  async function onSignOut() {
    closeNavigation();
    await signOut();
    router.replace('/login');
  }

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)');
    const onResize = () => {
      if (desktop.matches) drawerRef.current?.close();
    };
    desktop.addEventListener('change', onResize);
    return () => desktop.removeEventListener('change', onResize);
  }, []);

  const skipLink = (
    <a
      href="#main"
      className="sr-only z-[100] focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:rounded-lg focus:bg-panel focus:px-4 focus:py-2 focus:font-semibold focus:text-accent focus:shadow-xl"
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

  const home = NAVIGATION[user.role][0].href;
  const account = (
    <UserPanel name={user.displayName} role={user.role} onSignOut={() => void onSignOut()} />
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      {skipLink}
      <aside className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r border-line bg-panel px-4 pt-5 pb-4 lg:flex">
        <Link href={home} className="ml-2 w-fit rounded-lg">
          <BrandMark />
          <span className="sr-only"> home</span>
        </Link>
        <nav aria-label="Main" className="mt-8">
          <Navigation role={user.role} />
        </nav>
        <div className="mt-auto pt-6">{account}</div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-line bg-panel px-4 sm:px-6 xl:px-8">
          <Link href={home} className="rounded-lg lg:hidden">
            <BrandMark />
            <span className="sr-only"> home</span>
          </Link>
          <p className="hidden text-sm font-semibold text-muted-strong lg:block">
            {ROLE_LABEL[user.role]} workspace
          </p>
          <div className="flex items-center gap-2">
            <div className="hidden lg:block">
              <ThemeSelect />
            </div>
            {user.role === 'EMPLOYEE' && (
              <NotificationBell
                centre={centre}
                className="border border-line bg-panel text-muted-strong hover:bg-panel-hover"
              />
            )}
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded={open}
              aria-controls="mobile-navigation"
              onClick={() => {
                centre.setOpen(false);
                drawerRef.current?.showModal();
                setOpen(true);
              }}
              className="grid size-10 place-items-center rounded-lg border border-line bg-panel text-muted-strong hover:bg-panel-hover lg:hidden"
            >
              <Menu aria-hidden="true" size={20} />
            </button>
          </div>
        </header>
        {user.role === 'EMPLOYEE' && <NotificationPanel centre={centre} />}

        <dialog
          ref={drawerRef}
          id="mobile-navigation"
          aria-label="Navigation"
          className="app-drawer"
          onClose={() => setOpen(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeNavigation();
          }}
        >
          <div className="flex min-h-full flex-col gap-5 p-4">
            <div className="flex items-center justify-between gap-3">
              <BrandMark />
              <button
                type="button"
                aria-label="Close navigation"
                onClick={closeNavigation}
                className="grid size-10 place-items-center rounded-lg text-muted-strong hover:bg-panel-hover"
              >
                <X aria-hidden="true" size={21} />
              </button>
            </div>
            {open && (
              <>
                <nav aria-label="Main">
                  <Navigation role={user.role} onNavigate={closeNavigation} />
                </nav>
                <div className="mt-auto space-y-4">
                  <ThemeSelect />
                  {account}
                </div>
              </>
            )}
          </div>
        </dialog>

        <main id="main" className="mx-auto w-full max-w-[90rem] px-4 py-6 sm:px-6 sm:py-8 xl:px-8">
          {status === 'loading' ? null : children}
        </main>
      </div>
    </div>
  );
}
