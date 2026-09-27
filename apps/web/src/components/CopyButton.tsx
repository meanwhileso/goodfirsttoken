import { useEffect, useRef, useState } from 'react';
import { cx } from './cx';

/** Puts text on the clipboard. Resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const RESET_AFTER_MS = 1600;

/**
 * A `copy` button that says `copied` in place, or `select it` when the
 * browser refuses, then goes back to `copy`. `name` is what a screen reader
 * calls it, like `Copy prompt`, and a status beside it says what happened.
 */
export function CopyButton({ text, name, className }: { text: string; name: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'refused'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); }, []);

  async function copy() {
    setState((await copyText(text)) ? 'copied' : 'refused');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setState('idle'); }, RESET_AFTER_MS);
  }

  return (
    <>
      <button type="button" className={cx('copy-btn', className)} aria-label={name} onClick={() => void copy()}>
        {{ idle: 'copy', copied: 'copied', refused: 'select it' }[state]}
      </button>
      <span className="visually-hidden" role="status">
        {{ idle: '', copied: 'Copied.', refused: 'The browser would not copy. Select the text and copy it.' }[state]}
      </span>
    </>
  );
}
