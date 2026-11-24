import type { Metadata } from 'next';
import { UserAdmin } from '@/components/admin/UserAdmin';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Admin' };

export default function AdminPage() {
  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Admin area"
        description="Manage access, roles, and account security across SmartDesk."
      />
      <UserAdmin />
    </section>
  );
}
