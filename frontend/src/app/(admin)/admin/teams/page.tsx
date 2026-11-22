import type { Metadata } from 'next';
import { TeamAdmin } from '@/components/admin/TeamAdmin';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Support teams' };

export default function AdminTeamsPage() {
  return (
    <section aria-labelledby="page-title">
      <PageHeader
        eyebrow="Administration"
        title="Support teams"
        description="Teams that tickets are routed to, and the technicians in them. Deactivate a team instead of deleting it; existing tickets keep it."
      />
      <TeamAdmin />
    </section>
  );
}
