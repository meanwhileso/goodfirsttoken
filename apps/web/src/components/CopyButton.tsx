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
 * browser refuses, then goes back to `copy`.
 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [label, setLabel] = useState<'copy' | 'copied' | 'select it'>('copy');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); }, []);

  async function copy() {
    const ok = await copyText(text);
    setLabel(ok ? 'copied' : 'select it');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setLabel('copy'); }, RESET_AFTER_MS);
  }

  return (
    <button type="button" className={cx('copy-btn', className)} onClick={() => void copy()}>
      <span aria-live="polite">{label}</span>
    </button>
  );
}
