import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

interface ButtonStyle {
  /** `primary` is ink, for the one main action. `danger` is for Disconnect, Reject, and Release. */
  variant?: 'primary' | 'danger';
  size?: 'sm';
}

function buttonClass({ variant, size }: ButtonStyle, className?: string): string {
  return cx('btn', variant && `btn--${variant}`, size === 'sm' && 'btn--sm', className);
}

/** A round button. With no variant it is the white secondary button. */
export function Button({ variant, size, className, type = 'button', ...props }: ButtonStyle & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={buttonClass({ variant, size }, className)} {...props} />;
}

/** A link that looks like a button, for an action that goes to another page. */
export function ButtonLink({ variant, size, className, ...props }: ButtonStyle & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={buttonClass({ variant, size }, className)} {...props} />;
}
