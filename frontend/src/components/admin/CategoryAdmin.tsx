'use client';

import { useMemo } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { catalogApi } from '@/lib/admin/catalogApi';
import { CatalogManager } from './CatalogManager';

export function CategoryAdmin() {
  const { api } = useAuth();
  const catalog = useMemo(() => catalogApi(api), [api]);
  return (
    <CatalogManager
      noun="category"
      plural="categories"
      load={catalog.categories}
      create={catalog.createCategory}
      update={catalog.updateCategory}
      setActive={catalog.setCategoryActive}
      deactivationEffects={(c) => (
        <>
          <p>
            It will no longer be offered when a technician triages a ticket or reviews an AI
            suggestion, and it cannot be chosen as a new evaluation label.
          </p>
          <p className="mt-1">
            The {c.ticketCount} {c.ticketCount === 1 ? 'ticket' : 'tickets'} already filed under it,
            existing knowledge articles and past reports keep it. You can reactivate it at any time.
          </p>
        </>
      )}
    />
  );
}
