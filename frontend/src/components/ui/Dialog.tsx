'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Modal dialog on the native `<dialog>` element: the browser traps focus inside, makes the rest of
 * the page inert, closes on Escape and returns focus to the control that opened it.
 * The parent owns `open`; `onClose` fires for Escape, the close button and backdrop clicks.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // React's `autoFocus` runs before the dialog is open, so the first-focus choice is explicit.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="app-dialog"
    >
      {open && (
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-lg font-semibold text-ink-strong">
              {title}
            </h2>
            <button
              type="button"
              aria-label="Close dialog"
              onClick={onClose}
              className="app-button-quiet -mt-1 -mr-2 size-10 shrink-0 !p-0"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          <div className="mt-3">{children}</div>
        </div>
      )}
    </dialog>
  );
}
