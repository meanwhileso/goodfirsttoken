import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * A label chip that names a section, like `merged this week`. `live` adds the
 * pulsing green dot. Use `as="h2"` when the marker is the section's heading.
 */
export function Marker({
  children,
  count,
  variant,
  as: Tag = 'span',
}: {
  children: ReactNode;
  count?: ReactNode;
  variant?: 'live';
  as?: 'span' | 'h2' | 'h3';
}) {
  return (
    <Tag className={cx('marker', variant && `marker--${variant}`)}>
      {children}
      {count != null && <span className="marker__count">{count}</span>}
    </Tag>
  );
}
