import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * A project rule and its value, like `PRs | automatic`. The value sits on
 * label tint, or on ink when it is `strict`, for a value like `reviewed`.
 */
export function SplitBadge({ rule, value, strict }: { rule: string; value: string; strict?: boolean }) {
  return (
    <span className={cx('badge', strict && 'badge--strict')}>
      <span className="badge__rule">{rule}</span>
      <span className="badge__value">{value}</span>
    </span>
  );
}

/** A row of split badges that wraps. */
export function SplitBadges({ children }: { children: ReactNode }) {
  return <div className="badges">{children}</div>;
}
