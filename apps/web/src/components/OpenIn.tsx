import { useEffect, useRef, useState } from 'react';
import { copyText } from './CopyButton';

/** Links that open each harness with the prompt filled in, by its own URL scheme. */
const OPEN_IN = [
  { name: 'claude code', href: (prompt: string) => `claude://code/new?q=${encodeURIComponent(prompt)}` },
  { name: 'codex', href: (prompt: string) => `codex://new?prompt=${encodeURIComponent(prompt)}` },
  {
    name: 'cursor',
    href: (prompt: string) => `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`,
  },
] as const;

// T3 Code registers its scheme but has no route that takes a prompt, so the
// button copies the prompt first and then opens the app.
const T3_CODE = 't3code://';
const OPEN_AFTER_MS = 600;

/** The `or open it in` line under a prompt. */
export function OpenIn({ prompt }: { prompt: string }) {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); }, []);

  async function openT3Code() {
    if (!(await copyText(prompt))) {
      setStatus('Copy the prompt, then open T3 Code and paste it in.');
      return;
    }
    setStatus('Prompt copied. Opening T3 Code, paste it in.');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { window.location.href = T3_CODE; }, OPEN_AFTER_MS);
  }

  return (
    <div className="open-in">
      <span>or open it in</span>
      {OPEN_IN.map((link) => (
        <a key={link.name} href={link.href(prompt)}>
          {link.name}
        </a>
      ))}
      <button type="button" onClick={() => void openT3Code()}>
        t3 code
      </button>
      <span role="status">{status}</span>
    </div>
  );
}
