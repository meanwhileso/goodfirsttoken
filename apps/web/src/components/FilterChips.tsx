import type { ReactNode } from 'react';

/** A chip that shows whether it is pressed. A pressed chip is filled with ink. */
export function ToggleChip({
  children,
  pressed,
  onPress,
}: {
  children: ReactNode;
  pressed: boolean;
  onPress: () => void;
}) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onPress}>
      {children}
    </button>
  );
}

/**
 * A row of toggle chips that filter a list, one pressed at a time, like
 * `this week` and `all time`. `label` names the group for screen readers.
 */
export function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="filter-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <ToggleChip key={option} pressed={option === value} onPress={() => { onChange(option); }}>
          {option}
        </ToggleChip>
      ))}
    </div>
  );
}
