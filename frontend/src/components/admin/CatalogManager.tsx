'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState, Notice } from '@/components/ui';
import { describeCatalogError, type CatalogInput } from '@/lib/admin/catalogApi';
import { inputClass, primaryButton } from '../tickets/ui';
import { ActiveBadge, ConfirmDeactivate, NameForm, smallButton } from './catalogParts';

export interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  ticketCount: number;
}

type Status = 'all' | 'active' | 'inactive';

/**
 * Shared list-and-edit view for categories and teams: search, filter by status, create, rename,
 * and deactivate with an explained confirmation. Nothing is ever deleted, so history stays intact.
 */
export function CatalogManager<T extends CatalogItem>({
  noun,
  plural,
  load,
  create,
  update,
  setActive,
  meta,
  deactivationEffects,
  renderExtra,
}: {
  /** Singular, lower case: "category" or "team". */
  noun: string;
  plural: string;
  load: () => Promise<T[]>;
  create: (input: CatalogInput) => Promise<T>;
  update: (id: string, input: CatalogInput) => Promise<T>;
  setActive: (id: string, active: boolean) => Promise<T>;
  /** Extra detail shown under the name, such as a member count. */
  meta?: (item: T) => string;
  /** What deactivation means for this item, shown before the administrator confirms. */
  deactivationEffects: (item: T) => ReactNode;
  /** Extra controls rendered inside an item (the team's members). */
  renderExtra?: (item: T, reload: () => Promise<void>) => ReactNode;
}) {
  const [items, setItems] = useState<T[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const reload = useCallback(async () => {
    try {
      setItems(await load());
      setLoadError(null);
    } catch (err) {
      setLoadError(describeCatalogError(err));
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      setMessage(await work());
      await reload();
      return true;
    } catch (err) {
      setActionError(describeCatalogError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (status === 'all' || (status === 'active') === i.isActive) &&
        (!q || `${i.name} ${i.description ?? ''}`.toLowerCase().includes(q)),
    );
  }, [items, query, status]);

  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  return (
    <div className="mt-6 space-y-6">
      <section aria-labelledby={`add-${noun}`} className="app-card space-y-3 p-5">
        <h2 id={`add-${noun}`} className="text-lg font-semibold">
          Add a {noun}
        </h2>
        <NameForm
          key={formKey}
          idPrefix={`new-${noun}`}
          initial={{ name: '', description: '' }}
          submitLabel={`Add ${noun}`}
          busy={busy}
          onSubmit={async (value) => {
            const ok = await act(async () => {
              const created = await create(value);
              return `${Noun} “${created.name}” added.`;
            });
            if (ok) setFormKey((k) => k + 1);
          }}
        />
      </section>

      {message && (
        <Notice tone="success" role="status">
          {message}
        </Notice>
      )}
      {actionError && (
        <Notice tone="danger" role="alert">
          {actionError}
        </Notice>
      )}

      <section aria-label={`${Noun} list`} className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-56 flex-1">
            <label
              htmlFor={`search-${noun}`}
              className="mb-1 block text-sm font-medium text-muted-strong"
            >
              Search
            </label>
            <input
              id={`search-${noun}`}
              type="search"
              className={inputClass}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor={`status-${noun}`}
              className="mb-1 block text-sm font-medium text-muted-strong"
            >
              Show
            </label>
            <select
              id={`status-${noun}`}
              className={inputClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
            >
              <option value="all">All</option>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
            </select>
          </div>
        </div>

        {loadError ? (
          <ErrorState
            message={loadError}
            action={
              <button type="button" className={primaryButton} onClick={() => void reload()}>
                Try again
              </button>
            }
          />
        ) : !items ? (
          <LoadingState label={`Loading ${plural}…`} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={items.length === 0 ? `No ${plural} yet` : `No ${plural} match`}
            description={
              items.length === 0
                ? `Add the first ${noun} above.`
                : 'Change the search or the filter.'
            }
          />
        ) : (
          <ul className="space-y-3">
            {visible.map((item) => (
              <li
                key={item.id}
                aria-label={item.name}
                className={`app-card space-y-3 p-4 ${item.isActive ? '' : 'bg-panel-muted'}`}
              >
                {editing === item.id ? (
                  <NameForm
                    idPrefix={`edit-${item.id}`}
                    initial={{ name: item.name, description: item.description ?? '' }}
                    submitLabel="Save changes"
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (value) => {
                      const ok = await act(async () => {
                        await update(item.id, value);
                        return `${Noun} “${value.name}” saved.`;
                      });
                      if (ok) setEditing(null);
                    }}
                  />
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-ink-strong">
                        <span className={item.isActive ? '' : 'text-muted'}>{item.name}</span>
                        <ActiveBadge active={item.isActive} />
                      </p>
                      {item.description && (
                        <p className="mt-1 text-sm text-muted">{item.description}</p>
                      )}
                      <p className="mt-1 text-xs text-muted">
                        {meta ? `${meta(item)} · ` : ''}
                        {item.ticketCount} {item.ticketCount === 1 ? 'ticket' : 'tickets'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={smallButton}
                        aria-label={`Edit ${item.name}`}
                        onClick={() => {
                          setEditing(item.id);
                          setConfirming(null);
                        }}
                      >
                        Edit
                      </button>
                      {item.isActive ? (
                        <button
                          type="button"
                          className={smallButton}
                          aria-label={`Deactivate ${item.name}`}
                          onClick={() => setConfirming(item.id)}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={smallButton}
                          aria-label={`Reactivate ${item.name}`}
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await setActive(item.id, true);
                              return `${Noun} “${item.name}” is active again.`;
                            })
                          }
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {confirming === item.id && item.isActive && (
                  <ConfirmDeactivate
                    title={`Deactivate “${item.name}”?`}
                    busy={busy}
                    onCancel={() => setConfirming(null)}
                    onConfirm={async () => {
                      const ok = await act(async () => {
                        await setActive(item.id, false);
                        return `${Noun} “${item.name}” deactivated.`;
                      });
                      if (ok) setConfirming(null);
                    }}
                  >
                    {deactivationEffects(item)}
                  </ConfirmDeactivate>
                )}

                {renderExtra?.(item, reload)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
