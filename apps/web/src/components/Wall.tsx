import { useEffect, useState } from 'react';
import { Chip } from './Chip';
import { cx } from './cx';
import { useReducedMotion } from './useReducedMotion';

/** One line of agent work on the wall. */
export interface WallLine {
  /** Stays the same for the life of the line, so a line that arrives later can be told apart. */
  id: string;
  /** The time as the wall shows it, like 14:02:51. */
  time: string;
  /** The GitHub login of the person whose agent did the work. */
  login: string;
  agent: string;
  /** The repository, as owner/name. */
  repo: string;
  issue: number;
  text: string;
}

const TYPE_EVERY_MS = 18;

/**
 * The live feed, newest line first. Lines that arrive after the wall first
 * renders rise in. With `typed`, the newest of them types itself out.
 * Each older line is dimmer than the one above. Under reduced motion, new
 * lines appear in full and nothing moves.
 */
export function Wall({ lines, typed = false }: { lines: readonly WallLine[]; typed?: boolean }) {
  const [first] = useState(() => new Set(lines.map((line) => line.id)));
  const reduced = useReducedMotion();
  return (
    <div className="wall">
      {lines.map((line, i) => {
        const arrived = !first.has(line.id);
        return <Line key={line.id} line={line} arrived={arrived} typing={typed && arrived && i === 0 && !reduced} />;
      })}
    </div>
  );
}

function Line({ line, arrived, typing }: { line: WallLine; arrived: boolean; typing: boolean }) {
  return (
    <div className={cx('wall-line', arrived && 'wall-line--new')}>
      <span className="wall-line__time">{line.time}</span>
      <div className="wall-line__body">
        <a className="wall-line__who" href={`/@${line.login}`}>
          @{line.login}
        </a>
        <Chip>{line.agent}</Chip>
        <a className="wall-line__issue" href={`/${line.repo}/issues/${String(line.issue)}`}>
          {line.repo}#{line.issue}
        </a>
        <TypedText text={line.text} typing={typing} />
      </div>
    </div>
  );
}

// Shows the text one character at a time, with a caret, while `typing` is
// on. When it goes off, as when a newer line arrives, the text shows in full.
function TypedText({ text, typing }: { text: string; typing: boolean }) {
  const [shown, setShown] = useState(typing ? 0 : text.length);
  const done = !typing || shown >= text.length;
  useEffect(() => {
    if (done) return;
    const timer = setTimeout(() => { setShown((n) => n + 1); }, TYPE_EVERY_MS);
    return () => { clearTimeout(timer); };
  }, [done, shown]);
  return (
    <span className="wall-line__text">
      {done ? text : text.slice(0, shown)}
      {!done && <span className="cursor" aria-hidden="true" />}
    </span>
  );
}
