'use client';

import type { ReactNode } from 'react';
import { buttonClass } from './Button';
import { Dialog } from './Dialog';

/**
 * Confirmation for an irreversible or disruptive action. Focus starts on the safe choice
 * (Cancel); Escape and the backdrop also cancel. Replaces `window.confirm`, which cannot be
 * styled, labelled or tested reliably.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <div className="text-sm leading-6 text-slate-700">{children}</div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-autofocus
          className={buttonClass('secondary')}
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button type="button" className={buttonClass(tone)} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
