/** One number and the words that go with it, like 14 merged. */
export interface Stat {
  value: number;
  label: string;
}

/** Numbers in big type with their words in muted text, read as one sentence. */
export function StatLine({ stats }: { stats: readonly Stat[] }) {
  return (
    <p className="stat-line">
      {stats.map((stat) => (
        <span key={stat.label}>
          <b>{stat.value.toLocaleString('en-US')}</b>
          {stat.label}
        </span>
      ))}
    </p>
  );
}
