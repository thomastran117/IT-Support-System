import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { buttonClass, cx, type ButtonVariant } from '@/components/ui';

/** A button that is disabled and labelled while its action is running. Defaults to `submit`. */
export function AsyncButton({
  pending,
  pendingLabel,
  variant = 'primary',
  type = 'submit',
  disabled,
  className,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  pending: boolean;
  pendingLabel: string;
  variant?: ButtonVariant;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      className={cx(buttonClass(variant), className)}
      {...props}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
