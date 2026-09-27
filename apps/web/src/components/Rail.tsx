import type { ReactNode } from 'react';
import { cx } from './cx';

/** An issue-timeline spine. Each section hangs off a ring node. */
export function Rail({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rail', className)}>{children}</div>;
}

/** A section on the rail. Its node is purple for live work, green for merged, and gray otherwise. */
export function RailSection({ children, node }: { children: ReactNode; node?: 'live' | 'merged' }) {
  return <section className={cx('rail__section', node && `rail__section--${node}`)}>{children}</section>;
}

/** The row at the top of a rail section: its marker, and anything that goes beside it. */
export function RailHead({ children }: { children: ReactNode }) {
  return <div className="rail__head">{children}</div>;
}
