import type { Metadata } from 'next';
import { CategoryAdmin } from '@/components/admin/CategoryAdmin';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Categories' };

export default function AdminCategoriesPage() {
  return (
    <section aria-labelledby="page-title">
      <PageHeader
        eyebrow="Administration"
        title="Categories"
        description="The categories technicians choose when triaging tickets. Deactivate a category instead of deleting it; existing tickets keep it."
      />
      <CategoryAdmin />
    </section>
  );
}
