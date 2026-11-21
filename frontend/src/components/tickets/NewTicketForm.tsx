'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ticketsApi } from '@/lib/tickets/api';
import { describeError } from '@/lib/tickets/format';
import {
  browserStorage,
  clearDraft,
  createSubmissionKeys,
  loadDraft,
  saveDraft,
  validateTicket,
  LIMITS,
  type TicketErrors,
} from '@/lib/tickets/validation';
import { Counter, ErrorSummary, inputClass, primaryButton, type SummaryItem } from './ui';

const FIELDS = ['title', 'description'] as const;

export function NewTicketForm() {
  const { api, user } = useAuth();
  const router = useRouter();
  const tickets = useMemo(() => ticketsApi(api), [api]);
  const keys = useRef(createSubmissionKeys());
  const submitting = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<TicketErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusSummary, setFocusSummary] = useState(0);

  // Restore an unsent draft (a failed submit, a reload or an expired session must not lose it).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !user) return;
    restored.current = true;
    const draft = loadDraft(user.id, browserStorage());
    setTitle(draft.title);
    setDescription(draft.description);
  }, [user]);

  useEffect(() => {
    if (focusSummary > 0) summaryRef.current?.focus();
  }, [focusSummary]);

  function update(next: { title?: string; description?: string }) {
    const values = { title, description, ...next };
    setTitle(values.title);
    setDescription(values.description);
    if (user && restored.current) saveDraft(user.id, values, browserStorage());
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current || !user) return;

    const found = validateTicket({ title, description });
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) {
      setFocusSummary((n) => n + 1);
      return;
    }

    submitting.current = true;
    setBusy(true);
    try {
      const values = { title: title.trim(), description: description.trim() };
      const ticket = await tickets.create(values, keys.current.keyFor(values));
      keys.current.reset();
      clearDraft(user.id, browserStorage());
      router.push(`/employee/tickets/${ticket.id}?created=1`);
    } catch (err) {
      // The text stays in the form (and in the stored draft) so nothing has to be retyped.
      setServerError(describeError(err, 'ticket'));
      setFocusSummary((n) => n + 1);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const summary: SummaryItem[] = [
    ...FIELDS.flatMap((f) => (errors[f] ? [{ field: f, message: errors[f] }] : [])),
    ...(serverError ? [{ field: 'title', message: serverError }] : []),
  ];

  return (
    <section aria-labelledby="page-title" className="max-w-2xl space-y-6">
      <div>
        <h1 id="page-title" className="text-2xl font-semibold">
          New ticket
        </h1>
        <p className="mt-1 text-slate-600">
          Tell us what is wrong. A technician will review it and reply here.
        </p>
      </div>

      <ErrorSummary ref={summaryRef} items={summary} />

      <form onSubmit={onSubmit} noValidate className="space-y-5" aria-busy={busy}>
        <div>
          <label htmlFor="title" className="block font-medium">
            Title
          </label>
          <input
            id="title"
            name="title"
            value={title}
            onChange={(e) => update({ title: e.target.value })}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={`title-count${errors.title ? ' title-error' : ''}`}
            autoComplete="off"
            className={inputClass}
          />
          {errors.title && (
            <p id="title-error" className="mt-1 text-sm font-medium text-red-700">
              {errors.title}
            </p>
          )}
          <Counter id="title-count" length={title.trim().length} max={LIMITS.title} />
        </div>

        <div>
          <label htmlFor="description" className="block font-medium">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={8}
            value={description}
            onChange={(e) => update({ description: e.target.value })}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={`description-count${errors.description ? ' description-error' : ''}`}
            className={inputClass}
          />
          {errors.description && (
            <p id="description-error" className="mt-1 text-sm font-medium text-red-700">
              {errors.description}
            </p>
          )}
          <Counter
            id="description-count"
            length={description.trim().length}
            max={LIMITS.description}
          />
        </div>

        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Submitting…' : 'Submit ticket'}
        </button>
      </form>
    </section>
  );
}
