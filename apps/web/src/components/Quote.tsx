import type { ReactNode } from 'react';

/** An issue body or a maintainer's words, with a rule on the left. */
export function Quote({ children }: { children: ReactNode }) {
  return <blockquote className="quote">{children}</blockquote>;
}
