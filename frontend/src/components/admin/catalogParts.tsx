'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { cx } from '@/components/ui';
import { inputClass, primaryButton, secondaryButton } from '../tickets/ui';

export const smallButton = 'app-button-secondary min-h-9 px-2.5 py-1.5';

export function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={cx(
        'inline-block rounded-full px-2 py-0.5 text-xs font-semibold',
        active ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-200 text-slate-800',
      )}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

/** Name and description with a Save button, for creating or editing a category or team. */
export function NameForm({
  idPrefix,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: { name: string; description: string };
  submitLabel: string;
  busy: boolean;
  onSubmit: (value: { name: string; description: string | null }) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [touched, setTouched] = useState(false);
  const problem = !name.trim()
    ? 'Enter a name.'
    : name.trim().length > 100
      ? 'Use 100 characters or fewer.'
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    onSubmit({ name: name.trim(), description: description.trim() || null });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-3" noValidate>
      <div className="min-w-48 flex-1">
        <label
          htmlFor={`${idPrefix}-name`}
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Name
        </label>
        <input
          id={`${idPrefix}-name`}
          className={inputClass}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={touched && problem ? true : undefined}
          aria-describedby={touched && problem ? `${idPrefix}-name-problem` : undefined}
        />
        {touched && problem && (
          <p id={`${idPrefix}-name-problem`} className="mt-1 text-sm text-rose-700">
            {problem}
          </p>
        )}
      </div>
      <div className="min-w-64 flex-[2]">
        <label
          htmlFor={`${idPrefix}-description`}
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Description (optional)
        </label>
        <input
          id={`${idPrefix}-description`}
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex items-end gap-2 self-end">
        <button type="submit" className={primaryButton} disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className={secondaryButton} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Explains what deactivating does before it happens, and asks for an explicit confirmation. */
export function ConfirmDeactivate({
  title,
  children,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={title}
      className="rounded-xl border border-amber-200 bg-amber-50 p-4"
    >
      <p className="font-semibold text-amber-950">{title}</p>
      <div className="mt-1 text-sm leading-6 text-amber-950">{children}</div>
      <div className="mt-3 flex gap-2">
        <button type="button" className="app-button-danger" disabled={busy} onClick={onConfirm}>
          Confirm deactivation
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Keep active
        </button>
      </div>
    </div>
  );
}
