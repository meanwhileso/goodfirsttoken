import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton';
import { cx } from './cx';

/**
 * The prompt box, the one dark surface, with a copy button. `children` is
 * what the box shows and `copy` is the exact text the button copies. A
 * `shell` prompt is a small one-line command with a `$`.
 */
export function Prompt({
  children,
  copy,
  shell = false,
  caret = false,
}: {
  children: ReactNode;
  copy: string;
  shell?: boolean;
  caret?: boolean;
}) {
  return (
    <div className={cx('prompt', shell && 'prompt--sm prompt--shell')}>
      <span className="prompt__text">
        {children}
        {caret && <span className="prompt__caret" aria-hidden="true" />}
      </span>
      <CopyButton text={copy} />
    </div>
  );
}

/** The part of a prompt set in the accent color, like the URL. */
export function PromptAccent({ children }: { children: ReactNode }) {
  return <span className="prompt__accent">{children}</span>;
}
