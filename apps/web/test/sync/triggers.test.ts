import { newClaim, type ClaimRecord, type TriggerHarnessName, type WakeLevel } from '@goodfirsttoken/core';
import type { D1Migration } from 'cloudflare:test';
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addPr,
  getWake,
  giveToWake,
  saveClaim,
  saveFollowThrough,
  saveFollowUps,
  saveSubmission,
  saveTrigger,
  sortFollowUps,
  turnTriggerOn,
} from '../../src/db';
import worker from '../../src/server';
import { PR_JOB_CRON } from '../../src/sync/scheduled';
import { callTriggers, callTriggersAfterPass, openTriggerKey, sealTriggerKey, type TriggerFetch } from '../../src/sync/triggers';
import { startGitHub } from '../auth/helpers';
import { DAY, db, emptyDatabase, HOUR, kenji, maintainer, MINUTE, priya, registeredProject, repo, sha, signIn, t0 } from '../db/helpers';
import { freshNumbers, knowServiceToken } from './helpers';

// Calling the donor's trigger when a follow-up comes
// (docs/specs/follow-through.md, under Waking a run when a follow-up
// comes), with a fetch the test gives in place of the harness. Every
// person, repo, comment, routine, and key here is made up.

const CLOUD_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_01SampleRoutine/fire';
const CURSOR_URL = 'https://api2.cursor.sh/automations/webhook/sample-automation-1';
const KEY = 'sk-ant-oat01-sample-key-for-tests';
const REVIEW_TEXT = 'Please keep the trailing slash in /docs/ rewrites.';

/** A claim the room holds as pr_opened, with its PR. */
function openedClaim(claimId: string, number: number, who = priya): ClaimRecord {
  return {
    id: claimId,
    issue: `${repo}#${String(number - 40)}`,
    project: repo,
    githubId: who.githubId,
    login: who.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    tokenEstimate: null,
    ...newClaim(t0),
    state: 'pr_opened',
    submittedAt: t0 + HOUR,
    pr: { repo, number, url: `https://github.com/${repo}/pull/${String(number)}` },
  };
}

/** A claim with its submit and its open PR, as record_pr leaves it. */
async function openPr(claimId: string, number: number, who = priya): Promise<void> {
  await saveClaim(db, openedClaim(claimId, number, who), 1);
  await saveSubmission(db, {
    claimId,
    source: 'files',
    repo: `${who.login}/sample-app`,
    branch: `goodfirsttoken/issue-${String(number - 40)}-${claimId}`,
    commit: 'a'.repeat(40),
    base: sha,
    diffFrom: sha,
    paths: ['src/rewrite.ts'],
    title: 'Keep the trailing slash in rewrites',
    summary: 'Keeps the slash.',
    checks: 'pnpm test',
    agent: 'claude-code',
    model: 'claude-opus-5-5',
    additions: 3,
    deletions: 1,
    reviewReason: null,
    submittedAt: t0 + HOUR,
    clearance: null,
  });
  await addPr(db, { claimId, pr: { repo, number, url: `https://github.com/${repo}/pull/${String(number)}` }, openedAt: t0 + HOUR });
}

/** A follow-up the PR job read at `readAt`, by a maintainer or a bot. */
async function followUp(claimId: string, commentId: string, readAt: number, authorKind: 'maintainer' | 'bot' = 'maintainer') {
  await saveFollowUps(
    db,
    claimId,
    [
      {
        commentId,
        kind: 'review',
        reviewer: authorKind === 'bot' ? 'sample-review-bot' : maintainer.login,
        authorKind,
        body: REVIEW_TEXT,
        path: null,
        url: `https://github.com/${repo}/pull/57#pullrequestreview-${commentId}`,
        writtenAt: readAt - MINUTE,
      },
    ],
    readAt,
  );
}

/** A wake of the donor's with a trigger saved on it. */
async function wakeWithTrigger(
  harness: TriggerHarnessName = 'claude-code-cloud',
  level: WakeLevel = 'notify',
  who = priya,
  url = harness === 'claude-code-cloud' ? CLOUD_URL : CURSOR_URL,
): Promise<string> {
  const saved = await saveFollowThrough(db, who.githubId, { save: { harness, level, intervalMinutes: 60 } }, t0);
  if (saved.saved === null) throw new Error('no wake saved');
  const wakeId = saved.saved.id;
  const withTrigger = await saveTrigger(db, who.githubId, wakeId, { harness, url, sealedKey: await sealTriggerKey(KEY) }, t0);
  if (withTrigger === null) throw new Error('no trigger saved');
  return wakeId;
}

interface Call {
  url: string;
  init: RequestInit;
}

/** The body a call sent, which is always text. */
const bodyOf = (c: Call | undefined) => (typeof c?.init.body === 'string' ? c.init.body : '');

/** A fetch that stands in for the harness, answering each call with the next status, or 200. */
function harness(...statuses: (number | 'hang' | 'throw')[]) {
  const calls: Call[] = [];
  const fetch: TriggerFetch = (url, init) => {
    calls.push({ url, init });
    const next = statuses.shift() ?? 200;
    if (next === 'throw') return Promise.reject(new TypeError('network'));
    if (next === 'hang') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return Promise.resolve(new Response(next === 302 ? null : '{}', { status: next, headers: next === 302 ? { location: 'https://elsewhere.example/' } : {} }));
  };
  return { calls, fetch };
}

let clock: number;
const at = (time: number) => {
  clock = time;
};
const call = (fetch: TriggerFetch, more: { timeoutMs?: number } = {}) => callTriggers({ db, fetch, now: () => clock, ...more });
/** How many calls one pass made. */
const made = async (fetch: TriggerFetch) => (await call(fetch)).called;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, maintainer);
  await registeredProject();
  await openPr('c_1', 57);
  clock = t0 + 2 * HOUR;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('what the call sends', () => {
  test("a Claude Code cloud task's trigger is posted its key and the wake's ID, and nothing from the repo, the PR, or the donor", async () => {
    const wakeId = await wakeWithTrigger('claude-code-cloud', 'notify');
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { calls, fetch } = harness();

    const run = await call(fetch);

    expect(run).toMatchObject({ called: 1, fired: 1 });
    expect(calls).toHaveLength(1);
    const [only] = calls;
    expect(only?.url).toBe(CLOUD_URL);
    expect(only?.init.method).toBe('POST');
    expect(only?.init.redirect).toBe('manual');
    expect(only?.init.headers).toEqual({ authorization: `Bearer ${KEY}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(JSON.parse(bodyOf(only))).toEqual({ text: `Wake ID: ${wakeId}` });
    const sent = JSON.stringify(only?.init);
    for (const never of [repo, 'pull/57', priya.login, maintainer.login, REVIEW_TEXT, 'c_1', 'r1']) expect(sent).not.toContain(never);
  });

  test("Grok Bot's and Cursor Automations' webhooks take the wake's ID as JSON", async () => {
    const grok = await wakeWithTrigger('grok-bot', 'full');
    const cursor = await wakeWithTrigger('cursor-automations', 'full');
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { calls, fetch } = harness();

    await call(fetch);

    expect(calls.map((c) => c.url)).toEqual([CURSOR_URL, CURSOR_URL]);
    expect(calls.map(bodyOf).sort()).toEqual([JSON.stringify({ wakeId: grok }), JSON.stringify({ wakeId: cursor })].sort());
    expect(calls.map((c) => c.init.headers)).toEqual([
      { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    ]);
  });

  test("the key is stored sealed with AUTH_SECRET, and opens to the key the donor pasted", async () => {
    const wakeId = await wakeWithTrigger();

    const stored = await db.prepare('SELECT trigger_key FROM wakes WHERE id = ?').bind(wakeId).first<string>('trigger_key');

    expect(stored).not.toBeNull();
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain('sk-ant');
    expect(await openTriggerKey(stored ?? '')).toBe(KEY);
    expect(JSON.stringify(await getWake(db, priya.githubId, wakeId))).not.toContain(stored ?? 'none');
  });
});

describe('when Good First Token calls a trigger', () => {
  test('each follow-up brings one call: a new one brings another, and one called for brings none', async () => {
    await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { fetch } = harness();

    const first = await made(fetch);
    at(clock + 30 * MINUTE);
    const again = await made(fetch);
    await followUp('c_1', 'r2', clock);
    at(clock + 30 * MINUTE);
    const fresh = await made(fetch);

    expect([first, again, fresh]).toEqual([1, 0, 1]);
  });

  test("a notify wake isn't called for a follow-up my_work already gave it", async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    await giveToWake(db, wakeId, [{ claimId: 'c_1', followUpId: 'r1' }], t0 + 100 * MINUTE);
    const { calls, fetch } = harness();

    await call(fetch);

    expect(calls).toEqual([]);
  });

  test('a full wake is called for an open follow-up, and not for one its run sorted to wait for the reviewer', async () => {
    await wakeWithTrigger('grok-bot', 'full');
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    await sortFollowUps(db, 'c_1', [{ followUpId: 'r1', state: 'waiting_reviewer' }], t0 + 100 * MINUTE);
    const { fetch } = harness();

    const sorted = await made(fetch);
    await followUp('c_1', 'r2', clock);
    const open = await made(fetch);
    const { results } = await db.prepare('SELECT comment_id FROM trigger_follow_ups').all<{ comment_id: string }>();

    expect([sorted, open]).toEqual([0, 1]);
    expect(results.map((row) => row.comment_id)).toEqual(['r2']);
  });

  test('no call for a PR the donor stopped following', async () => {
    await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    await saveFollowThrough(db, priya.githubId, { mode: { mode: 'off', claimId: 'c_1' } }, t0);
    const { calls, fetch } = harness();

    await call(fetch);

    expect(calls).toEqual([]);
  });

  test('no call for a PR whose follow-ups all wait for the donor', async () => {
    await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    await sortFollowUps(db, 'c_1', [{ followUpId: 'r1', state: 'waiting_donor', question: 'Cover the admin feed too?' }], t0 + 100 * MINUTE);
    const { calls, fetch } = harness();

    await call(fetch);

    expect(calls).toEqual([]);
  });

  test('no call for a PR at its round limit for the day, or in all', async () => {
    await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const today = Math.floor(clock / DAY);
    const { fetch } = harness();

    await db.prepare('UPDATE prs SET rounds = 3, rounds_day = ?, rounds_on_day = 3').bind(today).run();
    const atDayLimit = await made(fetch);
    await db.prepare('UPDATE prs SET rounds = 10, rounds_day = ?, rounds_on_day = 0').bind(today - 1).run();
    const atTotalLimit = await made(fetch);
    await db.prepare('UPDATE prs SET rounds = 9').run();
    const under = await made(fetch);

    expect([atDayLimit, atTotalLimit, under]).toEqual([0, 0, 1]);
  });

  test("a bot's follow-up on a PR past its bot rounds brings no call, and a maintainer's still does", async () => {
    await wakeWithTrigger();
    await db.prepare('UPDATE prs SET bot_rounds = 3').run();
    await followUp('c_1', 'bot1', t0 + 90 * MINUTE, 'bot');
    const { fetch } = harness();

    const bots = await made(fetch);
    await followUp('c_1', 'r1', clock, 'maintainer');
    const maintainers = await made(fetch);

    expect([bots, maintainers]).toEqual([0, 1]);
  });

  test("a full wake's call waits while another run holds the PR's lease, and goes with a later pass once it ends", async () => {
    await wakeWithTrigger('grok-bot', 'full');
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    await db.prepare("UPDATE prs SET lease_run = 'run-elsewhere', lease_until = ?").bind(clock + 20 * MINUTE).run();
    const { fetch } = harness();

    const held = await made(fetch);
    at(clock + 30 * MINUTE);
    const ended = await made(fetch);

    expect([held, ended]).toEqual([0, 1]);
  });

  test("a notify wake is called while a run holds the lease, since a run that only reports takes none", async () => {
    await wakeWithTrigger('claude-code-cloud', 'notify');
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    await db.prepare("UPDATE prs SET lease_run = 'run-elsewhere', lease_until = ?").bind(clock + 20 * MINUTE).run();
    const { calls, fetch } = harness();

    await call(fetch);

    expect(calls).toHaveLength(1);
  });

  test("a full wake's run only reports on an ask_first PR, so it is called while a lease is held, for one that waits for the donor too", async () => {
    await wakeWithTrigger('grok-bot', 'full');
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    await followUp('c_1', 'r2', t0 + 91 * MINUTE);
    await sortFollowUps(db, 'c_1', [{ followUpId: 'r2', state: 'waiting_donor', question: 'Cover the admin feed too?' }], t0 + 100 * MINUTE);
    await saveFollowThrough(db, priya.githubId, { mode: { mode: 'ask_first', claimId: 'c_1' } }, t0);
    await db.prepare("UPDATE prs SET lease_run = 'run-elsewhere', lease_until = ?").bind(clock + 20 * MINUTE).run();
    const { fetch } = harness();

    const run = await call(fetch);
    const { results } = await db.prepare('SELECT comment_id FROM trigger_follow_ups ORDER BY comment_id').all<{ comment_id: string }>();

    expect(run).toMatchObject({ called: 1, fired: 1 });
    expect(results.map((row) => row.comment_id)).toEqual(['r1', 'r2']);
  });

  test('a wake is called at most once in 15 minutes, and the follow-up it skipped goes with the next call', async () => {
    await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { calls, fetch } = harness();

    const first = await made(fetch);
    await followUp('c_1', 'r2', clock);
    at(clock + 14 * MINUTE);
    const soon = await made(fetch);
    at(clock + MINUTE);
    const later = await made(fetch);

    expect([first, soon, later]).toEqual([1, 0, 1]);
    expect(calls).toHaveLength(2);
  });

  test('a wake is called at most 12 times in a UTC day, and again the next day', async () => {
    await wakeWithTrigger();
    const { calls, fetch } = harness();
    const day = Math.floor(clock / DAY) * DAY;

    for (let i = 0; i < 13; i++) {
      at(day + 30 * MINUTE + i * 20 * MINUTE);
      await followUp('c_1', `r${String(i)}`, clock);
      await call(fetch);
    }
    const sameDay = calls.length;
    at(day + DAY + MINUTE);
    await call(fetch);

    expect(sameDay).toBe(12);
    expect(calls).toHaveLength(13);
  });

  test('a pass makes at most 50 calls, the ones called longest ago first, and the rest go with the next pass', async () => {
    const people = [priya, kenji, ...[3, 4, 5, 6].map((n) => ({ githubId: 1100 + n, login: `sample-donor-${String(n)}` }))];
    await signIn(...people.slice(2));
    for (const [i, who] of people.entries()) {
      if (who !== priya) await openPr(`c_${String(i + 2)}`, 60 + i, who);
      for (let w = 0; w < 9; w++) await wakeWithTrigger('claude-code-cloud', 'notify', who);
      await followUp(who === priya ? 'c_1' : `c_${String(i + 2)}`, `r${String(i)}`, t0 + 90 * MINUTE);
    }
    const { calls, fetch } = harness();

    const first = await call(fetch);
    at(clock + 30 * MINUTE);
    const second = await call(fetch);

    expect(first).toMatchObject({ called: 50, leftForNext: 1 });
    expect(second).toMatchObject({ called: 4, leftForNext: 0 });
    expect(new Set(calls.map(bodyOf)).size).toBe(54);
  });
});

describe('two passes, and a trigger saved again', () => {
  test('the wakes called longest ago go first, and one never called before them', async () => {
    const people = [priya, kenji, ...[3, 4, 5, 6].map((n) => ({ githubId: 1100 + n, login: `sample-donor-${String(n)}` }))];
    await signIn(...people.slice(2));
    const wakes: string[] = [];
    for (const [i, who] of people.entries()) {
      if (who !== priya) await openPr(`c_${String(i + 2)}`, 60 + i, who);
      for (let w = 0; w < 9; w++) wakes.push(await wakeWithTrigger('claude-code-cloud', 'notify', who));
      await followUp(who === priya ? 'c_1' : `c_${String(i + 2)}`, `r${String(i)}`, t0 + 90 * MINUTE);
    }
    // The last six were called before, so the 48 never called go first,
    // then the two of the six called longest ago.
    const before = wakes.slice(-6);
    const minutesAgo = [40, 50, 60, 30, 70, 20];
    for (const [i, wakeId] of before.entries()) {
      await db.prepare('UPDATE wakes SET trigger_called_at = ? WHERE id = ?').bind(clock - (minutesAgo[i] ?? 0) * MINUTE, wakeId).run();
    }
    const { calls, fetch } = harness();

    await call(fetch);

    const called = new Set(calls.map((c) => (JSON.parse(bodyOf(c)) as { text: string }).text.replace('Wake ID: ', '')));
    expect(called.size).toBe(50);
    expect(wakes.filter((wakeId) => !called.has(wakeId))).toEqual([before[0], before[1], before[3], before[5]]);
  });

  test('two passes at once call each trigger once', async () => {
    await wakeWithTrigger();
    await wakeWithTrigger('grok-bot', 'full');
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { calls, fetch } = harness();

    const [one, two] = await Promise.all([call(fetch), call(fetch)]);

    expect(calls).toHaveLength(2);
    expect(one.called + two.called).toBe(2);
  });

  test('a trigger the donor saved again during a call keeps its own state, and the old call records nothing on it', async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const fetch: TriggerFetch = async () => {
      await saveTrigger(db, priya.githubId, wakeId, { harness: 'claude-code-cloud', url: CLOUD_URL, sealedKey: await sealTriggerKey(KEY) }, t0 + 2 * HOUR);
      return new Response(null, { status: 401 });
    };

    await call(fetch);

    expect((await getWake(db, priya.githubId, wakeId))?.trigger).toMatchObject({ on: true, off: null, hasKey: true, failures: 0 });
  });

  test("saving a trigger again, or turning it on again, keeps a 429's hold", async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { fetch } = harness(429);
    const first = clock;

    await call(fetch);
    await saveTrigger(db, priya.githubId, wakeId, { harness: 'claude-code-cloud', url: CLOUD_URL, sealedKey: await sealTriggerKey(KEY) }, first + 20 * MINUTE);
    at(first + 30 * MINUTE);
    const afterSave = await made(fetch);
    await db.prepare("UPDATE wakes SET trigger_on = 0, trigger_off = 'failures' WHERE id = ?").bind(wakeId).run();
    await turnTriggerOn(db, priya.githubId, wakeId);
    at(first + 45 * MINUTE);
    const afterOn = await made(fetch);
    at(first + HOUR);
    const afterHour = await made(fetch);

    expect([afterSave, afterOn, afterHour]).toEqual([0, 0, 1]);
  });

  test("a call whose outcome can't be recorded leaves the other calls to go on and be recorded", async () => {
    const first = await wakeWithTrigger();
    const second = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    let failed = false;
    const flaky = {
      prepare: (query: string) => {
        if (!failed && query.includes('INSERT INTO trigger_follow_ups')) {
          failed = true;
          throw new Error('D1 is down for this one');
        }
        return db.prepare(query);
      },
      batch: (statements: D1PreparedStatement[]) => db.batch(statements),
    } as unknown as D1Database;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { calls, fetch } = harness();

    const run = await callTriggers({ db: flaky, fetch, now: () => clock });
    const recorded = await db.prepare('SELECT wake_id FROM trigger_follow_ups').all<{ wake_id: string }>();

    expect(calls).toHaveLength(2);
    expect(run.called).toBe(2);
    expect(recorded.results.map((row) => row.wake_id).filter((id) => id === first || id === second)).toHaveLength(1);
  });
});

describe('when a call fails', () => {
  test('a timeout, a 5xx, a redirect it never follows, or no answer counts one failure, and the next pass tries again', async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { calls, fetch } = harness(503, 302, 200);

    const first = await call(fetch);
    const afterOne = await getWake(db, priya.githubId, wakeId);
    at(clock + 30 * MINUTE);
    await call(fetch);
    const afterTwo = await getWake(db, priya.githubId, wakeId);
    at(clock + 30 * MINUTE);
    await call(fetch);
    const fired = await getWake(db, priya.githubId, wakeId);

    expect(first).toMatchObject({ called: 1, failed: 1, fired: 0 });
    expect(afterOne?.trigger).toMatchObject({ on: true, failures: 1, firedAt: null });
    expect(afterTwo?.trigger).toMatchObject({ on: true, failures: 2 });
    expect(calls.map((c) => c.url)).toEqual([CLOUD_URL, CLOUD_URL, CLOUD_URL]);
    expect(fired?.trigger).toMatchObject({ on: true, failures: 0, firedAt: clock });
  });

  test('a call waits at most 5 seconds for an answer, then counts as a failure', async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    let aborted: number | null = null;
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slow: TriggerFetch = (_, init) =>
      new Promise((_resolve, reject) => {
        reached();
        init.signal?.addEventListener('abort', () => {
          aborted = Date.now();
          reject(new DOMException('aborted', 'AbortError'));
        });
      });

    const running = call(slow);
    await started;
    await vi.advanceTimersByTimeAsync(4999);
    const before = aborted;
    await vi.advanceTimersByTimeAsync(1);
    const run = await running;

    expect(before).toBeNull();
    expect(aborted).not.toBeNull();
    expect(run).toMatchObject({ called: 1, failed: 1 });
    expect((await getWake(db, priya.githubId, wakeId))?.trigger?.failures).toBe(1);
  });

  test('three failed calls in a row turn the trigger off, keeping its key, and the donor can turn it on again', async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { calls, fetch } = harness(500, 'throw', 504);

    let run;
    for (let i = 0; i < 4; i++) {
      run = await call(fetch);
      at(clock + 30 * MINUTE);
    }
    const off = await getWake(db, priya.githubId, wakeId);
    const on = await turnTriggerOn(db, priya.githubId, wakeId);
    await call(fetch);

    expect(calls).toHaveLength(4);
    expect(run).toMatchObject({ called: 0 });
    expect(off?.trigger).toMatchObject({ on: false, off: 'failures', hasKey: true, failures: 3 });
    expect(on?.trigger).toMatchObject({ on: true, off: null, failures: 0 });
  });

  test('a 429 counts a failure and holds the wake for an hour', async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { fetch } = harness(429);
    const first = clock;

    const run = await call(fetch);
    const held = await getWake(db, priya.githubId, wakeId);
    at(first + 59 * MINUTE);
    const during = await made(fetch);
    at(first + 60 * MINUTE);
    const after = await made(fetch);

    expect(run).toMatchObject({ called: 1, held: 1, fired: 0 });
    expect(held?.trigger).toMatchObject({ on: true, failures: 1, heldUntil: first + HOUR });
    expect([during, after]).toEqual([0, 1]);
    expect((await getWake(db, priya.githubId, wakeId))?.trigger).toMatchObject({ on: true, failures: 0 });
  });

  test.each([
    [401, 'key'],
    [403, 'key'],
    [404, 'gone'],
    [410, 'gone'],
  ] as const)('a %i turns the trigger off at once, as %s, and drops its key', async (status, why) => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { calls, fetch } = harness(status);

    const run = await call(fetch);
    at(clock + DAY);
    await followUp('c_1', 'r2', clock);
    await call(fetch);

    expect(run).toMatchObject({ called: 1, turnedOff: 1 });
    expect(calls).toHaveLength(1);
    expect((await getWake(db, priya.githubId, wakeId))?.trigger).toMatchObject({ on: false, off: why, hasKey: false });
    expect(await db.prepare('SELECT trigger_key FROM wakes WHERE id = ?').bind(wakeId).first('trigger_key')).toBeNull();
    expect(await turnTriggerOn(db, priya.githubId, wakeId)).toBeNull();
  });

  test('a key that no longer opens, as after AUTH_SECRET changed, turns the trigger off and calls nothing', async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const { calls, fetch } = harness();

    await callTriggers({ db, fetch, now: () => clock, openKey: () => Promise.reject(new Error('bad key')) });

    expect(calls).toEqual([]);
    expect((await getWake(db, priya.githubId, wakeId))?.trigger).toMatchObject({ on: false, off: 'key' });
  });

  test("a failure in the calls is logged, with counts and no URL, key, or ID, and doesn't throw", async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
    vi.spyOn(console, 'error').mockImplementation((line: string) => void logged.push(line));
    const broken = { prepare: () => { throw new Error(`no database for ${wakeId}`); } } as unknown as D1Database;

    const failed = await callTriggersAfterPass({ db: broken, fetch: harness().fetch, now: () => clock });
    const ran = await callTriggersAfterPass({ db, fetch: harness(500).fetch, now: () => clock });

    expect(failed).toBeNull();
    expect(ran).toMatchObject({ called: 1, failed: 1 });
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      for (const never of [CLOUD_URL, 'api.anthropic.com', KEY, wakeId, priya.login]) expect(line).not.toContain(never);
    }
  });
});

describe('the migration and the wake', () => {
  test('a wake from before has no trigger, and the columns refuse a reason not on the list', async () => {
    const saved = await saveFollowThrough(db, priya.githubId, { save: { harness: 'grok-bot', level: 'full', intervalMinutes: 15 } }, t0);
    const wakeId = saved.saved?.id ?? '';
    const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };

    const row = await db.prepare('SELECT trigger_on, trigger_failures, trigger_calls_on_day, trigger_url FROM wakes WHERE id = ?').bind(wakeId).first();
    const odd = db.prepare("UPDATE wakes SET trigger_off = 'tired' WHERE id = ?").bind(wakeId).run();

    expect(TEST_MIGRATIONS.some((m) => m.name === '20261108223440_wake_triggers.sql')).toBe(true);
    expect(saved.saved?.trigger).toBeNull();
    expect(row).toEqual({ trigger_on: 0, trigger_failures: 0, trigger_calls_on_day: 0, trigger_url: null });
    await expect(odd).rejects.toThrow(/CHECK/);
  });

  test('a trigger is saved only on a wake in a harness that takes one, at a level that runs on its own, and only by its donor', async () => {
    const desktop = (await saveFollowThrough(db, priya.githubId, { save: { harness: 'claude-code-desktop', level: 'full', intervalMinutes: 15 } }, t0)).saved?.id ?? '';
    const session = (await saveFollowThrough(db, priya.githubId, { save: { harness: 'grok-bot', level: 'session', intervalMinutes: 15 } }, t0)).saved?.id ?? '';
    const grok = (await saveFollowThrough(db, priya.githubId, { save: { harness: 'grok-bot', level: 'full', intervalMinutes: 15 } }, t0)).saved?.id ?? '';
    const sealedKey = await sealTriggerKey(KEY);

    const onDesktop = await saveTrigger(db, priya.githubId, desktop, { harness: 'claude-code-cloud', url: CLOUD_URL, sealedKey }, t0);
    const onSession = await saveTrigger(db, priya.githubId, session, { harness: 'grok-bot', url: CURSOR_URL, sealedKey }, t0);
    const byKenji = await saveTrigger(db, kenji.githubId, grok, { harness: 'grok-bot', url: CURSOR_URL, sealedKey }, t0);
    const own = await saveTrigger(db, priya.githubId, grok, { harness: 'grok-bot', url: CURSOR_URL, sealedKey }, t0);

    expect([onDesktop, onSession, byKenji]).toEqual([null, null, null]);
    expect(own?.trigger).toMatchObject({ host: 'api2.cursor.sh', on: true, hasKey: true });
  });

  test('removing the wake removes its trigger and the follow-ups it was called for', async () => {
    const wakeId = await wakeWithTrigger();
    await followUp('c_1', 'r1', t0 + 90 * MINUTE);
    await call(harness().fetch);

    await saveFollowThrough(db, priya.githubId, { remove: wakeId }, clock);

    expect(await db.prepare('SELECT COUNT(*) AS n FROM wakes').first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM trigger_follow_ups').first('n')).toBe(0);
  });
});

describe('the PR job', () => {
  test('calls the trigger after it reads a new review, on its cron, with the GitHub fake beside it', async () => {
    const github = startGitHub();
    freshNumbers(github, repo);
    knowServiceToken(github);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const number = github.openPullRequest(repo, { title: 'Keep the slash', body: 'Closes #17', by: priya.login });
    await openPr('c_9', number);
    await emptyFollowUps();
    await wakeWithTrigger('claude-code-cloud', 'notify');
    github.reviewPullRequest(repo, number, { login: maintainer.login, state: 'COMMENTED', body: REVIEW_TEXT });
    const triggered: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      if (url.startsWith('https://api.anthropic.com/')) {
        triggered.push(url);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return github.fetch(input, init);
    });

    await worker.scheduled(createScheduledController({ cron: PR_JOB_CRON, scheduledTime: Date.now() }), env);

    expect(triggered).toEqual([CLOUD_URL]);
  });
});

/** Leaves c_1 out of the PR job's reads, so the test's own PR is the one it reads. */
async function emptyFollowUps(): Promise<void> {
  await db.prepare("UPDATE prs SET state = 'merged', merged_at = ? WHERE claim_id = 'c_1'").bind(t0 + 2 * HOUR).run();
}
