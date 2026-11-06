import { MODEL } from './version';

// What the reader's calls cost, from each result's usage and a price
// table, in dollars. The Worker keeps each day's spend from these, and the
// eval reports a run's cost with them. Batches cost half of every price.

/** Dollars per million tokens. Cache writes are the one-hour TTL the reader asks for. */
export const PRICES: Record<string, { input: number; output: number; cacheWrite1h: number; cacheWrite5m: number; cacheRead: number }> = {
  [MODEL]: { input: 4, output: 20, cacheWrite1h: 8, cacheWrite5m: 5, cacheRead: 0.2 },
};

/** The parts of a result's usage the cost depends on. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null;
}

const PER_MILLION = 1_000_000;

/** The dollars a call cost. A cache write with no breakdown counts at the one-hour price, the one the reader asks for. */
export function costOf(usage: UsageLike, options: { batch: boolean; model?: string }): number {
  const price = PRICES[options.model ?? MODEL];
  if (price === undefined) throw new Error(`No price for ${options.model ?? MODEL}`);
  const written = usage.cache_creation_input_tokens ?? 0;
  const fiveMinutes = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? written - fiveMinutes;
  const dollars =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    oneHour * price.cacheWrite1h +
    fiveMinutes * price.cacheWrite5m +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead;
  return (dollars / PER_MILLION) * (options.batch ? 0.5 : 1);
}

/**
 * A rough count of a text's tokens, for an estimate made with no network:
 * one for every three characters, which errs high for English prose and
 * Markdown. The shadow run replaces estimates with what usage reports.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
