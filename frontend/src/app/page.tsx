import Link from 'next/link';

const entries = [
  { href: '/login', label: 'Sign in', hint: 'Authentication' },
  { href: '/employee', label: 'Employee', hint: 'Submit and track tickets' },
  { href: '/technician', label: 'Technician', hint: 'Work assigned tickets' },
  { href: '/admin', label: 'Admin', hint: 'Manage the system' },
];

export default function Home() {
  return (
    <div>
      <h1 className="text-3xl font-semibold">SmartDesk</h1>
      <p className="mt-2 text-slate-600">IT support ticketing. Choose where to go.</p>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2">
        {entries.map((e) => (
          <li key={e.href}>
            <Link
              href={e.href}
              className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-500"
            >
              <span className="font-medium">{e.label}</span>
              <span className="block text-sm text-slate-500">{e.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
