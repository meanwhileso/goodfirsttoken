import type { ReaderRequest } from './requests';
import { PRICES, estimateTokens } from './pricing';
import { MODEL } from './version';

// The day's budget for the model, in US dollars, and its shares. Before the
// Worker sends a request it reserves the most the request could cost, and
// settles to the real cost when the result comes back, so nothing in flight
// can overspend. Each kind of read has a share of the day: admin seeds 50%,
// requested repos 20%, register_project 10%, and the last 20% only for
// weekly reads and second readings for a pause, which may also spend what
// the other shares left unspent. What a share leaves unspent is known only
// late in the day, so weekly reads take it from LATE_HOUR UTC on, and
// before then a seed always finds its half. The design is in
// docs/specs/model-policy-reader.md, under The budget.

/** Each share of the day's budget. */
export const SHARES = { seeds: 0.5, requests: 0.2, register: 0.1, weekly: 0.2 } as const;
export type Share = keyof typeof SHARES;
export const SHARE_NAMES = Object.keys(SHARES) as Share[];

/** The UTC hour from which weekly reads may spend what the other shares left unspent. */
export const LATE_HOUR = 18;

/** The UTC day a time falls on, like 2026-11-05. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The start of the next UTC day after a time. */
export function nextUtcDay(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}

const PER_MILLION = 1_000_000;

/**
 * A rough count of a text's tokens, from its UTF-8 bytes, one for every
 * three: about one a character for text in scripts like Chinese, where a
 * count of characters would reserve too little, and high for English.
 */
function tokensOf(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 3);
}

function textOf(content: ReaderRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('');
}

/**
 * The most a request could cost: its messages at the input price, the
 * system prompt at the one-hour cache write price, and max_tokens at the
 * output price, at batch or full price.
 */
export function reservationOf(request: ReaderRequest, { batch }: { batch: boolean }): number {
  const price = PRICES[request.model] ?? PRICES[MODEL];
  if (price === undefined) throw new Error(`No price for ${request.model}`);
  const system = typeof request.system === 'string' ? request.system : (request.system ?? []).map((block) => block.text).join('');
  const input = Math.max(
    estimateTokens(request.messages.map((message) => textOf(message.content)).join('')),
    tokensOf(request.messages.map((message) => textOf(message.content)).join('')),
  );
  const dollars = input * price.input + Math.max(estimateTokens(system), tokensOf(system)) * price.cacheWrite1h + request.max_tokens * price.output;
  return (dollars / PER_MILLION) * (batch ? 0.5 : 1);
}

/** What each share used in a day: spent and reserved. */
export type DayUse = Record<Share, number>;

export function noUse(): DayUse {
  return { seeds: 0, requests: 0, register: 0, weekly: 0 };
}

/**
 * One day's budget, with what each share used. Each share may spend up to
 * its part of the day. From LATE_HOUR UTC, weekly reads may also spend what
 * the others left, up to the whole day, since the other shares together
 * can't spend more than 80%.
 */
export class DayBudget {
  readonly #budget: number;
  readonly #used: DayUse;
  readonly #late: boolean;

  constructor(budget: number, used: DayUse, now: number) {
    this.#budget = budget;
    this.#used = { ...used };
    this.#late = new Date(now).getUTCHours() >= LATE_HOUR;
  }

  /** Whether the share may spend this much more. */
  allows(share: Share, cost: number): boolean {
    const total = SHARE_NAMES.reduce((sum, name) => sum + this.#used[name], 0);
    if (total + cost > this.#budget) return false;
    if (share === 'weekly' && this.#late) return true;
    return this.#used[share] + cost <= this.#budget * SHARES[share];
  }

  /** Reserves the cost for the share, when it may spend it. True when it reserved it. */
  reserve(share: Share, cost: number): boolean {
    if (!this.allows(share, cost)) return false;
    this.#used[share] += cost;
    return true;
  }
}
