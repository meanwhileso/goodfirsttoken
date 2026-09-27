import type { ReactNode } from 'react';

/** The one purple label a display headline may hold, set inside the sentence. */
export function InlineLabel({ children }: { children: ReactNode }) {
  return <span className="inline-label">{children}</span>;
}
