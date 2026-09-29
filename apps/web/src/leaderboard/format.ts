// How the leaderboard and a person's page write their numbers.

/** A merge rate from 0 to 1 as a whole percent, like 67%, or `none yet` with no PR merged or closed. */
export function formatRate(rate: number | null): string {
  return rate === null ? 'none yet' : `${String(Math.round(rate * 100))}%`;
}

/** A token count, short: 950, 12K, 3.1M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toLocaleString('en-US');
  const [size, unit] = tokens < 1_000_000 ? [1000, 'K'] : [1_000_000, 'M'];
  const value = tokens / size;
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value).toLocaleString('en-US');
  return `${shown}${unit}`;
}
