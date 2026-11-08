import { z } from 'zod';
import type { WakeHarness } from './follow-through';

// The trigger a wake can have (docs/specs/follow-through.md, under Waking
// a run when a follow-up comes): a URL in the donor's own harness that
// starts a run of the follow skill, which Good First Token calls when a
// follow-up comes, with a key the donor pastes on /me. Three harnesses take
// one. Each takes one URL pattern, over HTTPS, here in the code, so /me
// saves no URL that reaches anywhere else. docs/architecture.md, under The
// follow skill in each harness, says which patterns were tried in the
// product.

/** How one harness's trigger is called. */
export interface TriggerHarness {
  /** The one host its URL may have. */
  host: string;
  /** What its URL's path must be, whole. */
  path: RegExp;
  /** The URL's form, for the donor, as its docs give it. */
  form: string;
}

/**
 * The harnesses that take a trigger, each with its URL's pattern.
 *
 * - Claude Code's cloud scheduled tasks: a routine's API trigger, from
 *   platform.claude.com/docs/en/api/claude-code/routines-fire. Its ID
 *   starts with `trig_`.
 * - Grok Bot and Cursor Automations: a routine's or an automation's
 *   webhook. Their docs, cursor.com/help/grok-bot/routines and
 *   cursor.com/docs/cloud-agent/automations, give no pattern, and say to
 *   copy the URL the app shows. This one is from the reports of people who
 *   use them, and wasn't tried.
 */
export const TRIGGER_HARNESSES = {
  'claude-code-cloud': {
    host: 'api.anthropic.com',
    path: /^\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]{1,128}\/fire$/,
    form: 'https://api.anthropic.com/v1/claude_code/routines/trig_.../fire',
  },
  'grok-bot': {
    host: 'api2.cursor.sh',
    path: /^\/automations\/webhook\/[A-Za-z0-9_-]{1,128}$/,
    form: 'https://api2.cursor.sh/automations/webhook/...',
  },
  'cursor-automations': {
    host: 'api2.cursor.sh',
    path: /^\/automations\/webhook\/[A-Za-z0-9_-]{1,128}$/,
    form: 'https://api2.cursor.sh/automations/webhook/...',
  },
} as const satisfies Partial<Record<WakeHarness, TriggerHarness>>;

export type TriggerHarnessName = keyof typeof TRIGGER_HARNESSES;

/** Whether a wake in the harness can have a trigger. */
export function takesTrigger(harness: WakeHarness): harness is TriggerHarnessName {
  return Object.hasOwn(TRIGGER_HARNESSES, harness);
}

/** The longest URL a trigger takes. */
export const MAX_TRIGGER_URL = 512;

/** The longest key a trigger takes, so it fits a header. */
export const MAX_TRIGGER_KEY = 1024;

/**
 * Checks a URL the donor pasted for a wake's trigger in the harness: HTTPS,
 * the harness's host with no port, name, or password, its path whole, and
 * no query or fragment. Gives the URL as it is called, and its host, or the
 * problem in words for the donor.
 */
export function checkTrigger(
  harness: WakeHarness,
  pasted: string,
): { ok: true; url: string; host: string } | { ok: false; problem: string } {
  if (!takesTrigger(harness)) return { ok: false, problem: "A wake in this harness can't have a trigger." };
  const pattern: TriggerHarness = TRIGGER_HARNESSES[harness];
  const refused = { ok: false as const, problem: `The URL has to be the trigger's own, like ${pattern.form}` };
  const text = pasted.trim();
  // The whole URL is read here, with no parser, so nothing a parser would
  // fold, like a port, a name and password, `..`, or an escape, gets past.
  const parts = text.length > MAX_TRIGGER_URL ? null : /^https:\/\/([^/?#\s]+)(\/[^?#\s]*)$/i.exec(text);
  const host = parts?.[1]?.toLowerCase();
  const path = parts?.[2];
  if (host !== pattern.host || path === undefined || !pattern.path.test(path)) return refused;
  return { ok: true, url: `https://${host}${path}`, host };
}

/**
 * The key the donor pasted, or null when it is none a header can carry.
 * A harness that shows the whole header, like Grok Bot, may be pasted as
 * it is: `Authorization:` and `Bearer` before the key are left out.
 */
export function triggerKeyOf(pasted: string): string | null {
  const key = pasted
    .trim()
    .replace(/^authorization:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .trim();
  if (key === '' || /^bearer$/i.test(key) || key.length > MAX_TRIGGER_KEY) return null;
  return /^[\x21-\x7e]+$/.test(key) ? key : null;
}

/** Why Good First Token turned a trigger off: the key was wrong, the trigger is gone, or three calls in a row failed. */
export const triggerOffReasonSchema = z.enum(['key', 'gone', 'failures']);
export type TriggerOffReason = z.infer<typeof triggerOffReasonSchema>;

const MINUTE = 60_000;

/** The least time between two calls of one wake's trigger. */
export const TRIGGER_EVERY_MS = 15 * MINUTE;

/** The most calls of one wake's trigger in a UTC day. */
export const TRIGGER_CALLS_PER_DAY = 12;

/** How long a call waits for the harness's answer. */
export const TRIGGER_TIMEOUT_MS = 5000;

/** The most calls one pass of the PR job makes. The rest go with the next pass. */
export const TRIGGER_CALLS_PER_PASS = 50;

/** The failed calls in a row that turn a trigger off. */
export const TRIGGER_FAILURES_OFF = 3;

/** How long a 429 holds a wake's calls. */
export const TRIGGER_HOLD_MS = 60 * MINUTE;
