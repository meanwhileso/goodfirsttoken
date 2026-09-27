import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface Tab {
  /** The chip's words, like `this week`. */
  label: string;
  panel: ReactNode;
}

/**
 * Chips that pick one panel, following the WAI-ARIA tabs pattern. The chosen
 * chip is ink. The left and right arrow keys, Home, and End move between
 * chips, and the other panels are hidden.
 */
export function Tabs({ label, tabs, panelClassName }: { label: string; tabs: readonly Tab[]; panelClassName?: string }) {
  const id = useId();
  const [selected, setSelected] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = tabs.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: selected === last ? 0 : selected + 1,
      ArrowLeft: selected === 0 ? last : selected - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setSelected(next);
    buttons.current[next]?.focus();
  }

  return (
    <div>
      <div className="tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            ref={(el) => { buttons.current[i] = el; }}
            type="button"
            className="chip"
            role="tab"
            id={`${id}-tab-${String(i)}`}
            aria-controls={`${id}-panel-${String(i)}`}
            aria-selected={i === selected}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => { setSelected(i); }}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div
          key={tab.label}
          className={panelClassName}
          role="tabpanel"
          id={`${id}-panel-${String(i)}`}
          aria-labelledby={`${id}-tab-${String(i)}`}
          tabIndex={0}
          hidden={i !== selected}
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
