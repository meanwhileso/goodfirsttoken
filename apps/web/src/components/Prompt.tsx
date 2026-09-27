import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton';
import { cx } from './cx';

/**
 * The prompt box, the one dark surface, with a copy button. `children` is
 * what the box shows and `copy` is the exact text the button copies. A
 * `shell` prompt is a small one-line command with a `$`. A `small` prompt
 * is the same size with the prompt's `›`, for a command typed into an agent,
 * like a slash command. `copyName` is what a screen reader calls the button,
 * `Copy prompt` or `Copy command` unless set.
 */
export function Prompt({
  children,
  copy,
  shell = false,
  small = shell,
  caret = false,
  copyName = small ? 'Copy command' : 'Copy prompt',
}: {
  children: ReactNode;
  copy: string;
  shell?: boolean;
  small?: boolean;
  caret?: boolean;
  copyName?: string;
}) {
  return (
    <div className={cx('prompt', small && 'prompt--sm', shell && 'prompt--shell')}>
      <span className="prompt__text">
        {children}
        {caret && <span className="prompt__caret" aria-hidden="true" />}
      </span>
      <CopyButton text={copy} name={copyName} />
    </div>
  );
}

/** The part of a prompt set in the accent color, like the URL. */
export function PromptAccent({ children }: { children: ReactNode }) {
  return <span className="prompt__accent">{children}</span>;
}

/**
 * A path in a prompt, like `owner/repo#18` or a URL. It keeps to one line
 * when it fits on one, and starts a new line to do so. When it is wider than
 * the box, it wraps after a slash that joins two names, and a name breaks in
 * the middle only when it can't fit on a line of its own. A `<wbr>` adds no
 * character, so a screen reader, and a person who selects the text and
 * copies it, get the text as it is.
 */
export function PromptPath({ children }: { children: string }) {
  const parts = children.split(/(?<=[^\s/]\/)(?=[^\s/])/);
  return <span className="prompt__path">{parts.flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]))}</span>;
}
