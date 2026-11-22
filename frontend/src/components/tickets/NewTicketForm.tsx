'use client';

import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AsyncButton } from '@/components/forms/AsyncButton';
import { FormField } from '@/components/forms/FormField';
import { PageHeader } from '@/components/ui';
import { useFocusTarget } from '@/lib/forms/useFocusTarget';
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
import { Counter, ErrorSummary, inputClass, type SummaryItem } from './ui';

const FIELDS = ['title', 'description'] as const;

export function NewTicketForm() {
  const { api, user } = useAuth();
  const router = useRouter();
  const tickets = useMemo(() => ticketsApi(api), [api]);
  const keys = useRef(createSubmissionKeys());
  const submitting = useRef(false);
  const { ref: summaryRef, focus: focusSummary } = useFocusTarget<HTMLDivElement>();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<TicketErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Restore an unsent draft (a failed submit, a reload or an expired session must not lose it).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !user) return;
    restored.current = true;
    const draft = loadDraft(user.id, browserStorage());
    setTitle(draft.title);
    setDescription(draft.description);
  }, [user]);

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
      focusSummary();
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
      focusSummary();
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
    <section aria-labelledby="page-title" className="max-w-3xl space-y-6">
      <PageHeader
        eyebrow="Support request"
        title="New ticket"
        description="Describe what is blocking you and the support team will take it from here."
      />

      <ErrorSummary ref={summaryRef} items={summary} />

      <form
        onSubmit={onSubmit}
        noValidate
        className="app-card space-y-6 p-5 sm:p-7"
        aria-busy={busy}
      >
        <FormField
          id="title"
          label="Title"
          error={errors.title}
          footerId="title-count"
          footer={<Counter id="title-count" length={title.trim().length} max={LIMITS.title} />}
        >
          {(control) => (
            <input
              {...control}
              name="title"
              value={title}
              onChange={(e) => update({ title: e.target.value })}
              autoComplete="off"
              className={inputClass}
            />
          )}
        </FormField>

        <FormField
          id="description"
          label="Description"
          error={errors.description}
          footerId="description-count"
          footer={
            <Counter
              id="description-count"
              length={description.trim().length}
              max={LIMITS.description}
            />
          }
        >
          {(control) => (
            <textarea
              {...control}
              name="description"
              rows={8}
              value={description}
              onChange={(e) => update({ description: e.target.value })}
              className={inputClass}
            />
          )}
        </FormField>

        <AsyncButton pending={busy} pendingLabel="Submitting…">
          <Send aria-hidden="true" size={16} />
          Submit ticket
        </AsyncButton>
      </form>
    </section>
  );
}
