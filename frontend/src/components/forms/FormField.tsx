import type { ReactNode } from 'react';

export interface FieldControlProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

/**
 * Label, optional hint, control and error, wired together: the error is linked to the control with
 * `aria-describedby`, the control is marked `aria-invalid`, and the ids are predictable
 * (`<id>-hint`, `<id>-error`) so error summaries can link to the field.
 *
 * `footer` renders under the error (for a character counter) and `footerId` joins the description.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  footer,
  footerId,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  footer?: ReactNode;
  footerId?: string;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const describedBy =
    [hint ? `${id}-hint` : null, footerId ?? null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="app-label">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="-mt-1 mb-1.5 text-sm text-muted">
          {hint}
        </p>
      )}
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {footer}
    </div>
  );
}
