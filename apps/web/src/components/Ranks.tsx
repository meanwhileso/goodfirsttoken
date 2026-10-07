/** One ranked person: their GitHub login, their agent, and their score. */
export interface Rank {
  login: string;
  agent: string;
  score: number;
}

/** A ranked list with huge numerals. The first numeral uses ink. */
export function Ranks({ ranks }: { ranks: readonly Rank[] }) {
  return (
    <ol className="ranks">
      {ranks.map((rank, i) => (
        <li key={rank.login}>
          <span className="ranks__n">{i + 1}</span>
          <span className="ranks__who">
            @{rank.login} <small className="ranks__agent">{rank.agent}</small>
          </span>
          <span className="ranks__score">{rank.score.toLocaleString('en-US')}</span>
        </li>
      ))}
    </ol>
  );
}
