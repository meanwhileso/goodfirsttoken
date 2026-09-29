/** One number and the words that go with it, like 14 merged. */
export interface Stat {
  /** A count, written with its thousands, or a figure already written, like 67%. */
  value: number | string;
  label: string;
}

/**
 * Numbers in big type with their words in muted text, read as one sentence.
 * A real space follows each number, so a screen reader says `3 tagged`.
 */
export function StatLine({ stats }: { stats: readonly Stat[] }) {
  return (
    <p className="stat-line">
      {stats.map((stat) => (
        <span key={stat.label}>
          <b>{typeof stat.value === 'number' ? stat.value.toLocaleString('en-US') : stat.value}</b> {stat.label}
        </span>
      ))}
    </p>
  );
}
