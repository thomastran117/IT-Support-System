import type { Metadata } from 'next';
import { UserAdmin } from '@/components/admin/UserAdmin';

export const metadata: Metadata = { title: 'Admin' };

export default function AdminPage() {
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title" className="text-2xl font-semibold">
        Admin area
      </h1>
      <p className="mt-2 mb-8 text-slate-600">Manage accounts and roles.</p>
      <UserAdmin />
    </section>
  );
}
