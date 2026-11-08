import {
  TRIGGER_CALLS_PER_PASS,
  TRIGGER_TIMEOUT_MS,
  type TriggerHarnessName,
} from '@goodfirsttoken/core';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { authSecret } from '../auth/settings';
import { listTriggersDue, recordTriggerCall, takeTriggerCall, type TriggerCall, type TriggerOutcome } from '../db';

// Calling the donor's trigger when a follow-up comes
// (docs/specs/follow-through.md, under Waking a run when a follow-up
// comes). After each pass of the PR job writes what it read, src/sync/
// scheduled.ts calls each wake's trigger that has follow-ups it wasn't
// called for, by the rules in listTriggersDue (src/db/triggers.ts). The
// call starts a run of the follow skill in the donor's own harness, on
// their own plan, and sends only what the harness needs and the wake's ID:
// no repo text, no PR link, and no GitHub login. The run reads the rest
// with my_work. The key is sealed with AUTH_SECRET, as connected_agents
// keeps an agent's GitHub token (src/mcp/connections.ts), and only a call
// opens it. The rules are in docs/how-it-works.md, under PRs.

/** Seals a trigger's key with AUTH_SECRET, for the wakes table. */
export function sealTriggerKey(key: string): Promise<string> {
  return symmetricEncrypt({ key: authSecret(), data: key });
}

/** Opens a key sealTriggerKey sealed. */
export function openTriggerKey(sealed: string): Promise<string> {
  return symmetricDecrypt({ key: authSecret(), data: sealed });
}

/** How many calls go out at once, so 50 that each wait 5 seconds take about 25. */
const AT_ONCE = 10;

/** The fetch the calls go through, which a test replaces. */
export type TriggerFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TriggerDeps {
  db: D1Database;
  fetch: TriggerFetch;
  now: () => number;
  /** Opens a sealed key. openTriggerKey, unless a test gives another. */
  openKey?: (sealed: string) => Promise<string>;
  /** How long a call waits, TRIGGER_TIMEOUT_MS unless a test gives another. */
  timeoutMs?: number;
}

/** What one pass's calls did, for its log line. Counts only. */
export interface TriggerRun {
  /** Calls made. */
  called: number;
  /** Calls that started a run. */
  fired: number;
  /** Timeouts, 5xx answers, redirects, and other answers. */
  failed: number;
  /** 429 answers, which hold the wake's calls for an hour. */
  held: number;
  /** Triggers turned off: a wrong key, a trigger that is gone, or a third failure in a row. */
  turnedOff: number;
  /** Wakes due beyond the pass's 50, which go with the next pass. 1 means at least 1. */
  leftForNext: number;
  /** Calls whose outcome D1 didn't take, as when it failed. */
  unrecorded: number;
}

/**
 * The request that starts a run in the harness, with the wake's ID, and
 * nothing else from Good First Token. Claude Code's API trigger takes free
 * text, which reaches the run beside its saved prompt. Grok Bot and Cursor
 * Automations take a JSON body, which reaches the run with its
 * instruction.
 */
function requestFor(harness: TriggerHarnessName, wakeId: string, key: string): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  if (harness === 'claude-code-cloud') {
    // Every version from 2023-06-01 on behaves the same at this endpoint.
    headers['anthropic-version'] = '2023-06-01';
    return { headers, body: JSON.stringify({ text: `Wake ID: ${wakeId}` }) };
  }
  return { headers, body: JSON.stringify({ wakeId }) };
}

/** What an answer's status says of the call. A redirect isn't followed, and counts as a failure. */
function outcomeOf(status: number): TriggerOutcome {
  if (status >= 200 && status < 300) return 'fired';
  if (status === 401 || status === 403) return 'key';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429) return 'held';
  return 'failed';
}

/** Makes one call, waiting at most `timeoutMs`, and gives what it came to. */
async function callOnce(deps: TriggerDeps, call: TriggerCall): Promise<TriggerOutcome> {
  let key: string;
  try {
    key = await (deps.openKey ?? openTriggerKey)(call.sealedKey);
  } catch {
    // A key that can't be opened, as after AUTH_SECRET changed, starts
    // nothing, so the trigger turns off for the donor to save again.
    return 'key';
  }
  const { headers, body } = requestFor(call.harness, call.wakeId, key);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? TRIGGER_TIMEOUT_MS);
  try {
    const response = await deps.fetch(call.url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    return outcomeOf(response.status);
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls each wake's trigger that has follow-ups it wasn't called for, as
 * listTriggersDue finds them, at most 50 in a pass, 10 at a time. Each call
 * is taken first, in one statement, so two passes never both make it, and
 * its outcome is recorded on the trigger it was made for. A trigger the
 * donor removed or saved again meanwhile is left as they made it.
 */
export async function callTriggers(deps: TriggerDeps): Promise<TriggerRun> {
  const run: TriggerRun = { called: 0, fired: 0, failed: 0, held: 0, turnedOff: 0, leftForNext: 0, unrecorded: 0 };
  const due = await listTriggersDue(deps.db, deps.now(), TRIGGER_CALLS_PER_PASS + 1);
  run.leftForNext = Math.max(0, due.length - TRIGGER_CALLS_PER_PASS);
  const queue = due.slice(0, TRIGGER_CALLS_PER_PASS);
  const one = async (next: (typeof queue)[number]) => {
    const call = await takeTriggerCall(deps.db, next.wakeId, deps.now());
    if (call === null) return;
    run.called += 1;
    const outcome = await callOnce(deps, call);
    const { turnedOff } = await recordTriggerCall(deps.db, call, outcome, next.followUps, deps.now());
    if (outcome === 'fired') run.fired += 1;
    else if (outcome === 'held') run.held += 1;
    else if (outcome === 'failed') run.failed += 1;
    if (turnedOff) run.turnedOff += 1;
  };
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // One call D1 failed on leaves the others to go on. A call it took
      // and couldn't record counts against its caps, and its follow-ups go
      // with a later call.
      try {
        await one(next);
      } catch (error) {
        run.unrecorded += 1;
        console.error(`A trigger call wasn't recorded: ${error instanceof Error ? error.name : 'an error'}.`);
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return run;
}

/**
 * The PR job's calls, after a pass wrote what it read. A failure here is
 * logged and changes nothing the pass wrote, so a slow or broken trigger
 * can't break the job. The log gives counts only.
 */
export async function callTriggersAfterPass(deps: TriggerDeps): Promise<TriggerRun | null> {
  try {
    const run = await callTriggers(deps);
    if (run.called > 0 || run.leftForNext > 0) {
      console.log(
        `The PR job called triggers: ${String(run.called)}, started a run: ${String(run.fired)}, failed: ${String(run.failed)}, held by a 429: ${String(run.held)}, turned off: ${String(run.turnedOff)}, not recorded: ${String(run.unrecorded)}, left for the next pass: ${run.leftForNext > 0 ? 'some' : 'none'}.`,
      );
    }
    return run;
  } catch (error) {
    console.error(`The PR job's trigger calls stopped: ${error instanceof Error ? error.name : 'an error'}.`);
    return null;
  }
}
