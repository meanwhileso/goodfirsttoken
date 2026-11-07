import { env } from 'cloudflare:workers';

// The settings the policy reader reads to call the Anthropic API, all from
// the environment, read on each call so a test can change them.
// docs/specs/model-policy-reader.md says what each one does. The crawl
// consumer's half of the reader (src/crawl/model.ts) and its hourly run
// (src/crawl/batches.ts) read them.
//
// ANTHROPIC_API_URL is the API's base URL. Local development and tests point
// it at the fake in packages/anthropic-fake. A deploy that leaves it unset
// gets an empty value, and then calls go to the Anthropic API itself.
//
// ANTHROPIC_API_KEY is optional, and declared in src/optional-secrets.d.ts.
// With it, the model reads every policy. Without it, the crawler reads none.

export const ANTHROPIC_API = 'https://api.anthropic.com';

// A stand-in key for `pnpm dev`, which the Anthropic fake takes and the API
// never would. It is public, so it applies only in development, with the
// URL on this machine, and only when no key is set.
const LOCAL_API_KEY = 'local-only-not-a-real-anthropic-key';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

type Settings = Partial<Pick<Env, 'ENVIRONMENT' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_API_URL' | 'MODEL_DAILY_BUDGET_USD'>>;

/** The Anthropic API's base URL, from ANTHROPIC_API_URL, or the API itself when it is empty. */
export function anthropicUrl(): string {
  const url = ((env as Settings).ANTHROPIC_API_URL ?? '').trim();
  return url || ANTHROPIC_API;
}

// The API is a fake on this machine: the URL is http on a loopback host. A
// deploy refuses an ANTHROPIC_API_URL that isn't https, and a deployed
// Worker can't reach a loopback address.
function apiIsLocalFake(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The key the reader calls the API with, or null when there is none and the
 * reader reads nothing. In development, with the API the fake on this
 * machine, a missing key is the fake's stand-in, as sign-in does with the
 * GitHub fake's OAuth app.
 */
export function anthropicApiKey(): string | null {
  const settings = env as Settings;
  const key = (settings.ANTHROPIC_API_KEY ?? '').trim();
  if (key) return key;
  if (settings.ENVIRONMENT === 'development' && apiIsLocalFake(anthropicUrl())) return LOCAL_API_KEY;
  return null;
}

/**
 * The most the model may spend in a UTC day, in US dollars, from
 * MODEL_DAILY_BUDGET_USD. Empty, or a value that isn't a number of dollars,
 * means 0, which reads nothing.
 */
export function modelDailyBudgetUsd(): number {
  const value = ((env as Settings).MODEL_DAILY_BUDGET_USD ?? '').trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value)) return 0;
  return Number(value);
}
