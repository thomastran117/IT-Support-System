import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

/** Class for a button-looking element, e.g. a `Link` styled as a button. */
export const buttonClass = (variant: ButtonVariant = 'secondary') => `app-button-${variant}`;

export function Button({
  variant = 'secondary',
  type = 'button',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={cx(buttonClass(variant), className)} {...props} />;
}
