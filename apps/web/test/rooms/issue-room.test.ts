import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { ClaimRecord, FeedEvent, FeedMessage, PrRef } from '@goodfirsttoken/core';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addToDoNotList,
  blockDonor,
  createProject,
  getClaim,
  listIssueClaims,
  savePerson,
  unblockDonor,
} from '../../src/db';
import { issueRoom, type ClaimRequest, type ClaimResult, type IssueRoom } from '../../src/rooms/issue-room';
import { db, repo, sha, takeOffDoNotList } from '../db/helpers';
import { storedEvents } from '../feed/helpers';

// Every person, repo, and token here is made up.
//
// The tests set the clock with Vitest's fake Date, which the room reads too.
// The times are far ahead of the real clock, so no alarm a test sets fires
// on its own. A test runs each alarm it needs with runDurableObjectAlarm.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2100, 0, 4, 12, 0, 0);

const priya = { githubId: 3001, login: 'priya' };
const kenji = { githubId: 3002, login: 'kenji' };
const ana = { githubId: 3003, login: 'ana-codes' };
const ravi = { githubId: 3004, login: 'ravi' };
const mei = { githubId: 3005, login: 'mei' };
const admin = { githubId: 3900, login: 'sample-admin' };
type Person = typeof priya;

function prRef(number: number): PrRef {
  return { repo, number, url: `https://github.com/${repo}/pull/${String(number)}` };
}

// Each test works on its own issue, so each has its own room.
let issueNumber = 100;
let issue = '';
let room: DurableObjectStub<IssueRoom>;

beforeAll(async () => {
  for (const person of [priya, kenji, ana, ravi, mei, admin]) await savePerson(db, person, t0);
});

beforeEach(() => {
  issueNumber += 1;
  issue = `${repo}#${String(issueNumber)}`;
  room = issueRoom(env.ISSUE_ROOM, issue);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function at(time: number): void {
  vi.setSystemTime(time);
}

function request(person: Person, changes: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    issue,
    project: repo,
    githubId: person.githubId,
    login: person.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    slots: 3,
    ...changes,
  };
}

/** The claim a claim result holds, failing the test when it was refused. */
function claimOf(result: ClaimResult): ClaimRecord {
  if (!result.ok) throw new Error(`The claim was refused: ${result.refusal.message}`);
  return result.claim;
}

async function claim(person: Person, changes: Partial<ClaimRequest> = {}): Promise<ClaimRecord> {
  return claimOf(await room.claim(request(person, changes)));
}

async function post(claimed: ClaimRecord, text: string, job?: string) {
  return room.postUpdate({ claimId: claimed.id, githubId: claimed.githubId, text, job });
}

async function stateOf(claimed: ClaimRecord): Promise<string | undefined> {
  const { claims } = await room.snapshot();
  return claims.find((c) => c.id === claimed.id)?.state;
}

/**
 * The claim's state in D1 and the kind of the room's last event, read
 * without asking the room to apply its timers. So they show what the alarm
 * did.
 */
async function afterAlarm(claimed: ClaimRecord): Promise<[string | undefined, string | undefined]> {
  const events = await room.history();
  return [(await getClaim(db, claimed.id))?.state, events.at(-1)?.kind];
}

/** The events the room has yet to send to the feed queue, by their place in its history. */
async function unsent(): Promise<{ seq: number; tries: number }[]> {
  return runInDurableObject(room, (_, state) =>
    state.storage.sql.exec<{ seq: number; tries: number }>('SELECT seq, tries FROM outbox ORDER BY seq').toArray(),
  );
}

/**
 * The room's alarm, once its sends to the feed queue are done. A call's
 * answer doesn't wait for them, and a send sets the alarm again when it
 * ends.
 */
async function alarmTime(): Promise<number | null> {
  await vi.waitFor(async () => {
    expect(await unsent()).toEqual([]);
  });
  return runInDurableObject(room, (_, state) => state.storage.getAlarm());
}

/** The room's alarm, while events wait for their send. */
async function alarmTimeWhileUnsent(): Promise<number | null> {
  return runInDurableObject(room, (_, state) => state.storage.getAlarm());
}

/**
 * Puts a stand-in for the feed queue in the running room. It records what
 * the room sends, and refuses it while `down` is true. Until the room
 * restarts, the stand-in is its queue.
 */
async function standInQueue() {
  const queue = {
    down: false,
    hang: false,
    /** Refuses only the next batch. */
    refuseNext: false,
    batches: 0,
    sent: [] as FeedMessage[],
    sendBatch(messages: Iterable<{ body: unknown }>): Promise<void> {
      queue.batches += 1;
      if (queue.hang) return new Promise(() => undefined);
      if (queue.down || queue.refuseNext) {
        queue.refuseNext = false;
        return Promise.reject(new Error('The queue is down.'));
      }
      for (const { body } of messages) queue.sent.push(body as FeedMessage);
      return Promise.resolve();
    },
  };
  await runInDurableObject(room, (instance) => {
    const live = instance as unknown as { env: Env };
    live.env = new Proxy(live.env, {
      get: (target, key) => (key === 'FEED_QUEUE' ? queue : (Reflect.get(target, key) as unknown)),
    });
  });
  return queue;
}

/** Connects a watcher, and collects every event it is sent. */
async function watch(since?: string) {
  const res = await room.fetch(`https://room.test/${since ? `?since=${since}` : ''}`, {
    headers: { Upgrade: 'websocket' },
  });
  const socket = res.webSocket;
  if (!socket) throw new Error(`No WebSocket came back, status ${String(res.status)}.`);
  const events: FeedEvent[] = [];
  socket.addEventListener('message', (message) => {
    events.push(JSON.parse(String(message.data)) as FeedEvent);
  });
  socket.accept();
  return {
    events,
    socket,
    /** Waits until the watcher has `n` events. */
    async received(n: number) {
      await vi.waitFor(() => {
        expect(events).toHaveLength(n);
      });
      return events.map((e) => [e.kind, e.text]);
    },
  };
}

describe('the claim cap', () => {
  test('a fourth claim on a 3-claim issue is refused, even when all four arrive at once', async () => {
    const results = await Promise.all([priya, kenji, ana, ravi].map((person) => room.claim(request(person))));

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const refused = results.filter((r) => !r.ok);
    expect(refused.map((r) => r.refusal.code)).toEqual(['issue_full']);
    expect((await room.snapshot()).claims).toHaveLength(3);
    expect(await listIssueClaims(db, issue)).toHaveLength(3);
  });

  test("the number of slots is the project's claims per issue", async () => {
    await claim(priya, { slots: 1 });

    const second = await room.claim(request(kenji, { slots: 1 }));

    expect(second).toMatchObject({ ok: false, refusal: { code: 'issue_full' } });
  });

  test('each claim says how many slots are taken', async () => {
    const first = await room.claim(request(priya));
    const second = await room.claim(request(kenji));

    expect(first).toMatchObject({ ok: true, created: true, slotsTaken: 1, slots: 3 });
    expect(second).toMatchObject({ ok: true, created: true, slotsTaken: 2, slots: 3 });
  });

  test('claiming an issue you already hold gives back your claim, and takes no second slot', async () => {
    const first = await claim(priya);
    at(t0 + MINUTE);

    const again = await room.claim(request(priya, { agent: 'codex' }));

    expect(again).toMatchObject({ ok: true, created: false, slotsTaken: 1, claim: first });
    expect((await room.snapshot()).claims).toHaveLength(1);
  });

  test('a released claim frees its slot, and its reason is public', async () => {
    const watcher = await watch();
    const priyas = await claim(priya);
    await claim(kenji);
    await claim(ana);

    const released = await room.release({
      claimId: priyas.id,
      githubId: priya.githubId,
      reason: 'the tests need a GPU',
    });

    expect(released).toMatchObject({ ok: true, claim: { state: 'released', releaseReason: 'the tests need a GPU' } });
    expect(await room.claim(request(ravi))).toMatchObject({ ok: true, slotsTaken: 3 });
    expect((await watcher.received(5))[3]).toEqual(['released', 'released: the tests need a GPU']);
  });

  test('a claim past its deadline frees its slot even before its alarm runs', async () => {
    await claim(priya);
    await claim(kenji);
    await claim(ana);
    at(t0 + DAY);

    // No alarm has run. The claim applies the timers that are due first.
    expect(await room.claim(request(ravi))).toMatchObject({ ok: true, slotsTaken: 1 });
    const kinds = (await room.snapshot()).claims.map((c) => c.state);
    expect(kinds).toEqual(['expired', 'expired', 'expired', 'active']);
  });

  test('a paused claim keeps its slot until it expires, 24 hours after it was made', async () => {
    await claim(priya);
    await claim(kenji);
    await claim(ana);
    at(t0 + 30 * MINUTE);
    await runDurableObjectAlarm(room);

    at(t0 + DAY - 1);
    expect(await room.claim(request(ravi))).toMatchObject({ ok: false, refusal: { code: 'issue_full' } });
    expect((await room.snapshot()).claims.map((c) => c.state)).toEqual(['paused', 'paused', 'paused']);

    at(t0 + DAY);
    expect(await room.claim(request(ravi))).toMatchObject({ ok: true, slotsTaken: 1 });
  });

  test("a room refuses a claim on another issue, even as its first claim, so each issue's cap holds", async () => {
    const other = `${repo}#${String(issueNumber + 5000)}`;

    const wrongRoom = await room.claim(request(priya, { issue: other }));

    expect(wrongRoom).toMatchObject({ ok: false, refusal: { code: 'invalid_input' } });
    expect(!wrongRoom.ok && wrongRoom.refusal.message).toContain(`issue: ${other} has a room of its own`);
    expect(await room.snapshot()).toEqual({ issue: null, claims: [], prs: [] });
    const rightRoom = issueRoom(env.ISSUE_ROOM, other);
    const results = [];
    for (const person of [priya, kenji, ana, ravi]) results.push(await rightRoom.claim(request(person, { issue: other })));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(await listIssueClaims(db, other)).toHaveLength(3);
  });
});

describe('a new claim', () => {
  test('is active, holds the facts the room was given, and is saved to D1', async () => {
    const made = await claim(priya, { ownProject: true, agent: 'codex' });

    expect(made).toMatchObject({
      issue,
      project: repo,
      githubId: priya.githubId,
      login: priya.login,
      agent: 'codex',
      ownProject: true,
      startCommit: sha,
      tokenEstimate: null,
      state: 'active',
      claimedAt: t0,
      lastUpdateAt: t0,
    });
    expect(await getClaim(db, made.id)).toEqual(made);
  });

  test('every spelling of an issue reaches the same room', async () => {
    await claim(priya);
    const shouted = issueRoom(env.ISSUE_ROOM, issue.toUpperCase());

    const result = await shouted.claim(request(kenji, { issue: issue.toUpperCase(), slots: 1 }));

    expect(result).toMatchObject({ ok: false, refusal: { code: 'issue_full' } });
  });

  test('a malformed argument is refused with the field named, and changes nothing', async () => {
    const refusals = [
      await room.claim(request(priya, { startCommit: 'main' })),
      await room.claim(request(priya, { slots: 0 })),
      await room.postUpdate({ claimId: 'c_1', githubId: priya.githubId, text: '   ' }),
      await room.release({ claimId: 'c_1', githubId: priya.githubId, reason: '' }),
      await room.prOpened({ repo, number: 0, url: 'https://github.com/' }),
    ].map((result) => (result.ok ? 'accepted' : `${result.refusal.code} ${result.refusal.message}`));

    expect(refusals).toEqual([
      expect.stringMatching(/^invalid_input Nothing changed\.\nclaim.startCommit: /),
      expect.stringMatching(/^invalid_input Nothing changed\.\nslots: must be at least 1/),
      expect.stringMatching(/^invalid_input Nothing changed\.\ntext: /),
      expect.stringMatching(/^invalid_input Nothing changed\.\nreason: /),
      expect.stringMatching(/^invalid_input Nothing changed\.\npr.number: /),
    ]);
    expect(await room.snapshot()).toEqual({ issue: null, claims: [], prs: [] });
  });
});

describe('posting updates', () => {
  test("only the claim's owner can post to it", async () => {
    const made = await claim(priya);

    const result = await room.postUpdate({ claimId: made.id, githubId: kenji.githubId, text: 'fixed it for you' });

    expect(result).toMatchObject({ ok: false, refusal: { code: 'not_claim_owner' } });
    expect((await room.history()).map((e) => e.kind)).toEqual(['claimed']);
    expect(await room.postUpdate({ claimId: 'c_unknown', githubId: priya.githubId, text: 'hello' })).toMatchObject({
      ok: false,
      refusal: { code: 'not_found' },
    });
  });

  test('a post is stored and announced with its job', async () => {
    const made = await claim(priya);
    const watcher = await watch();
    at(t0 + MINUTE);

    const result = await post(made, 'tests: 214 passing', 'tests');

    expect(result).toEqual({
      ok: true,
      posted: true,
      waitSeconds: null,
      claimId: made.id,
      state: 'active',
      prOnIssue: null,
    });
    const [claimed, update] = await watcher.received(2).then(() => watcher.events);
    expect(claimed).toMatchObject({ kind: 'claimed', claim: made.id, user: 'priya', agent: 'claude-code' });
    expect(update).toMatchObject({
      kind: 'update',
      text: 'tests: 214 passing',
      job: 'tests',
      issue,
      time: new Date(t0 + MINUTE).toISOString(),
    });
  });

  test('a claim takes at most one post every 10 seconds, and a post that comes too soon says how long to wait', async () => {
    const made = await claim(priya);
    // The claim itself is no post, so the first line can follow at once.
    expect(await post(made, 'read the issue')).toMatchObject({ posted: true });

    at(t0 + 3200);
    expect(await post(made, 'wrote failing test')).toMatchObject({ ok: true, posted: false, waitSeconds: 7 });
    at(t0 + 9999);
    expect(await post(made, 'wrote failing test')).toMatchObject({ posted: false, waitSeconds: 1 });
    at(t0 + 10 * SECOND);
    expect(await post(made, 'wrote failing test')).toMatchObject({ posted: true, waitSeconds: null });

    const texts = (await room.history()).filter((e) => e.kind === 'update').map((e) => e.text);
    expect(texts).toEqual(['read the issue', 'wrote failing test']);
  });

  test('two posts on one claim at the same moment: one is stored, and the other waits', async () => {
    const made = await claim(priya);

    const results = await Promise.all([post(made, 'first line'), post(made, 'second line')]);

    expect(results.map((r) => r.ok && r.posted).sort()).toEqual([false, true]);
    expect((await room.history()).filter((e) => e.kind === 'update')).toHaveLength(1);
  });

  test('a claimant who posts every 10 minutes keeps the claim active', async () => {
    const made = await claim(priya);

    for (let minutes = 10; minutes <= 180; minutes += 10) {
      at(t0 + minutes * MINUTE);
      await runDurableObjectAlarm(room);
      expect(await post(made, `step ${String(minutes / 10)} done`)).toMatchObject({ posted: true, state: 'active' });
    }

    expect(await stateOf(made)).toBe('active');
    expect((await room.history()).some((e) => e.kind === 'paused')).toBe(false);
  });

  test('every update is a check-in: a claim with no update for 30 minutes is paused, and the next update wakes it', async () => {
    const made = await claim(priya);
    at(t0 + 10 * MINUTE);
    await post(made, 'reading src/range.ts');
    expect(await alarmTime()).toBe(t0 + 40 * MINUTE);

    at(t0 + 40 * MINUTE - 1);
    await runDurableObjectAlarm(room);
    expect(await afterAlarm(made)).toEqual(['active', 'update']);

    at(t0 + 40 * MINUTE);
    await runDurableObjectAlarm(room);
    expect(await afterAlarm(made)).toEqual(['paused', 'paused']);
    const paused = (await room.history()).at(-1);
    expect(paused).toMatchObject({ text: 'paused: no update for 30 minutes' });
    expect(await alarmTime()).toBe(t0 + DAY);

    at(t0 + 2 * HOUR);
    expect(await post(made, 'back on it')).toMatchObject({ posted: true, state: 'active' });
    expect((await getClaim(db, made.id))?.state).toBe('active');
  });
});

describe('expiry', () => {
  test('a claim expires 24 hours after it was made with no submit, however recent its last update', async () => {
    const made = await claim(priya);
    at(t0 + DAY - MINUTE);
    await post(made, 'almost there');
    expect(await alarmTime()).toBe(t0 + DAY);

    at(t0 + DAY);
    await runDurableObjectAlarm(room);

    expect(await afterAlarm(made)).toEqual(['expired', 'expired']);
    expect((await room.history()).at(-1)).toMatchObject({
      kind: 'expired',
      text: 'expired: no submit within 24 hours',
    });
    expect(await post(made, 'one more thing')).toMatchObject({ ok: false, refusal: { code: 'claim_expired' } });
  });

  test('work awaiting review expires 7 days after its first submit', async () => {
    const made = await claim(priya);
    at(t0 + HOUR);
    expect(await room.submit({ claimId: made.id, githubId: priya.githubId })).toMatchObject({
      ok: true,
      claim: { state: 'awaiting_review' },
    });
    expect(await alarmTime()).toBe(t0 + HOUR + 7 * DAY);

    at(t0 + HOUR + 7 * DAY - 1);
    await runDurableObjectAlarm(room);
    expect(await afterAlarm(made)).toEqual(['awaiting_review', 'submitted']);

    at(t0 + HOUR + 7 * DAY);
    await runDurableObjectAlarm(room);

    expect(await afterAlarm(made)).toEqual(['expired', 'expired']);
    expect((await room.history()).at(-1)).toMatchObject({
      kind: 'expired',
      text: 'expired: no PR within 7 days of the submit',
    });
  });

  test('a late alarm records each pause and expiry at its deadline, in the order of the deadlines', async () => {
    const priyas = await claim(priya);
    at(t0 + 5 * MINUTE);
    const kenjis = await claim(kenji);
    // Priya's post moves her pause after Kenji's, so the deadlines come in
    // another order than the claims.
    at(t0 + 20 * MINUTE);
    await post(priyas, 'reading the issue');

    at(t0 + 2 * HOUR);
    await runDurableObjectAlarm(room);
    at(t0 + 3 * DAY);
    await runDurableObjectAlarm(room);

    const changes = (await room.history()).filter((e) => e.kind === 'paused' || e.kind === 'expired');
    expect(changes.map((e) => [e.kind, e.claim, e.time])).toEqual([
      ['paused', kenjis.id, new Date(t0 + 35 * MINUTE).toISOString()],
      ['paused', priyas.id, new Date(t0 + 50 * MINUTE).toISOString()],
      ['expired', priyas.id, new Date(t0 + DAY).toISOString()],
      ['expired', kenjis.id, new Date(t0 + 5 * MINUTE + DAY).toISOString()],
    ]);
  });

  test('a room with nothing left to time, save, or send sets no alarm', async () => {
    const made = await claim(priya);
    await room.release({ claimId: made.id, githubId: priya.githubId, reason: 'picked another issue' });

    expect(await alarmTime()).toBeNull();
  });
});

describe('a PR on the issue', () => {
  test('once an open PR is linked to the issue, new claims are refused', async () => {
    await room.prOpened(prRef(57));

    const result = await room.claim(request(priya));

    expect(result).toMatchObject({ ok: false, refusal: { code: 'pr_exists' } });
    expect(!result.ok && result.refusal.message).toContain(prRef(57).url);
  });

  test('claimants still working get the PR link with their next update', async () => {
    const made = await claim(priya);
    await room.prOpened(prRef(57));

    expect(await post(made, 'still going')).toMatchObject({ posted: true, prOnIssue: prRef(57) });
  });

  test("a claim's own PR stops new claims, and only the other claimants are told about it", async () => {
    const priyas = await claim(priya);
    const kenjis = await claim(kenji);
    at(t0 + HOUR);
    await room.submit({ claimId: priyas.id, githubId: priya.githubId });

    const opened = await room.openPr({ claimId: priyas.id, githubId: priya.githubId, pr: prRef(60) });

    expect(opened).toMatchObject({ ok: true, claim: { state: 'pr_opened', pr: prRef(60) } });
    expect(await room.claim(request(ana))).toMatchObject({ ok: false, refusal: { code: 'pr_exists' } });
    expect(await post(kenjis, 'still going')).toMatchObject({ prOnIssue: prRef(60) });
    expect(await post(priyas, 'answered the review')).toMatchObject({ posted: true, prOnIssue: null });
    expect((await getClaim(db, priyas.id))?.pr).toEqual(prRef(60));
  });

  test('once the PR closes, the issue takes claims again', async () => {
    await room.prOpened(prRef(57));
    await room.prClosed(prRef(57));

    expect(await room.claim(request(priya))).toMatchObject({ ok: true });
  });
});

describe('keys and tokens', () => {
  // Built at run time, so no token-shaped string sits in this file.
  const token = `ghp_${'aB3dE5gH7jK9'.repeat(3)}`;

  test('a key or token in a post or a release reason is replaced before it is stored or sent', async () => {
    const made = await claim(priya);
    const watcher = await watch();

    await post(made, `ran the smoke test with ${token}`, `job-${token}`.slice(0, 40));
    await room.release({ claimId: made.id, githubId: priya.githubId, reason: `leaked ${token}, starting over` });

    const events = await watcher.received(3).then(() => watcher.events);
    expect(events[1]).toMatchObject({ text: 'ran the smoke test with [redacted]', job: 'job-[redacted]' });
    expect(events[2]).toMatchObject({ text: 'released: leaked [redacted], starting over' });
    expect((await room.history()).map((e) => e.text).join('\n')).not.toContain(token);
    expect((await getClaim(db, made.id))?.releaseReason).toBe('leaked [redacted], starting over');

    // Nothing the room stores holds the token.
    const stored = await runInDurableObject(room, (_, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
        .toArray();
      return tables.map(({ name }) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()));
    });
    expect(stored.length).toBeGreaterThan(0);
    for (const table of stored) expect(table).not.toContain(token.slice(4));
  });

  test('a post, job, or reason that a replacement makes longer than its limit is cut to the limit', async () => {
    const made = await claim(priya);
    // A two-character password becomes [redacted], eight characters longer.
    const link = 'https://u:pw@git.test';
    const job = `${'j'.repeat(40 - link.length - 1)} ${link}`;
    const text = `${'t'.repeat(200 - link.length - 1)} ${link}`;
    const reason = `${'r'.repeat(200 - link.length - 1)} ${link}`;

    expect(await post(made, text, job)).toMatchObject({ ok: true, posted: true });
    const released = await room.release({ claimId: made.id, githubId: priya.githubId, reason });

    const [, update, release] = await room.history();
    expect(update?.text).toHaveLength(200);
    expect(update?.job).toHaveLength(40);
    expect(released).toMatchObject({ ok: true });
    expect(released.ok && released.claim.releaseReason).toHaveLength(200);
    expect(release?.text).not.toContain(':pw@');
    for (const line of [update?.text, update?.job]) expect(line).not.toContain(':pw@');
  });
});

describe('watchers', () => {
  test('watchers get every event as it happens, one JSON feed event per message', async () => {
    const first = await watch();
    const second = await watch();
    const made = await claim(priya);
    at(t0 + MINUTE);
    await post(made, 'wrote failing test: parseRange drops the last byte');

    for (const watcher of [first, second]) {
      expect(await watcher.received(2)).toEqual([
        ['claimed', 'claimed the issue'],
        ['update', 'wrote failing test: parseRange drops the last byte'],
      ]);
    }
  });

  test('a watcher that reconnects with the last event ID it saw gets only what it missed', async () => {
    const made = await claim(priya);
    for (const [i, text] of ['one', 'two', 'three'].entries()) {
      at(t0 + (i + 1) * MINUTE);
      await post(made, text);
    }
    const seen = (await room.history())[1];

    const watcher = await watch(seen?.id);

    expect(await watcher.received(2)).toEqual([
      ['update', 'two'],
      ['update', 'three'],
    ]);
    at(t0 + 5 * MINUTE);
    await post(made, 'four');
    expect((await watcher.received(3))[2]).toEqual(['update', 'four']);
  });

  test('a watcher with no last event ID gets the whole history first', async () => {
    const made = await claim(priya);
    at(t0 + MINUTE);
    await post(made, 'one');

    const watcher = await watch();

    expect(await watcher.received(2)).toEqual([
      ['claimed', 'claimed the issue'],
      ['update', 'one'],
    ]);
  });

  test('a watcher that closes its socket gets the close answered', async () => {
    const watcher = await watch();
    let closedWith: number | null = null;
    watcher.socket.addEventListener('close', (event) => {
      closedWith = event.code;
    });

    watcher.socket.close(1000, 'done watching');

    await vi.waitFor(() => {
      expect(closedWith).toBe(1000);
    });
  });

  test('a request that is not a WebSocket upgrade is refused', async () => {
    const res = await room.fetch('https://room.test/');

    expect(res.status).toBe(426);
  });

  test("a slow send to the watchers that covered only older events leaves the retry of newer ones in place", async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const made = await claim(priya);
    const watcher = await watch();
    await watcher.received(1);
    // From here, the first block check answers after a while, and the next
    // one fails. The wait runs in the room, whose socket the answer reaches.
    let checks = 0;
    await runInDurableObject(room, (instance) => {
      const live = instance as unknown as { env: Env };
      const slowThenDown = {
        prepare: (query: string) => {
          if (!query.includes('donor_blocks')) return db.prepare(query);
          checks += 1;
          if (checks > 1) throw new Error('D1 is down.');
          const statement = {
            bind: () => statement,
            all: () =>
              new Promise((resolve) => {
                setTimeout(() => {
                  resolve({ results: [] });
                }, 300);
              }),
          };
          return statement;
        },
      } as unknown as D1Database;
      live.env = { ...live.env, DB: slowThenDown };
    });

    at(t0 + MINUTE);
    // Each call asks D1 before it answers. A wait here would move the clock.
    await post(made, 'first');
    expect(checks).toBe(1);
    await room.release({ claimId: made.id, githubId: priya.githubId, reason: 'done here' });
    expect(checks).toBe(2);
    // The slow check answers. Its send covered the post, and not the release.
    expect((await watcher.received(2))[1]).toEqual(['update', 'first']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runInDurableObject(room, (instance) => {
      (instance as unknown as { env: Env }).env = env;
    });

    expect(await alarmTime()).toBe(t0 + 2 * MINUTE);
    at(t0 + 2 * MINUTE);
    await runDurableObjectAlarm(room);
    expect((await watcher.received(3))[2]).toEqual(['released', 'released: done here']);
    warnings.mockRestore();
  });

  test('a watcher gets what D1 kept from going out a minute later, from the alarm', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const made = await claim(priya);
    const watcher = await watch();
    await watcher.received(1);
    // From here, the running room's D1 can't say who is blocked, and still
    // takes the room's saves.
    await runInDurableObject(room, (instance) => {
      const live = instance as unknown as { env: Env };
      const refusing = {
        prepare: (query: string) => {
          if (query.includes('donor_blocks')) throw new Error('D1 is down.');
          return db.prepare(query);
        },
      } as unknown as D1Database;
      live.env = { ...live.env, DB: refusing };
    });

    at(t0 + MINUTE);
    await post(made, 'while D1 was down');

    await vi.waitFor(async () => {
      expect(await alarmTime()).toBe(t0 + 2 * MINUTE);
    });
    expect(watcher.events).toHaveLength(1);
    await runInDurableObject(room, (instance) => {
      (instance as unknown as { env: Env }).env = env;
    });
    at(t0 + 2 * MINUTE);
    await runDurableObjectAlarm(room);
    expect((await watcher.received(2))[1]).toEqual(['update', 'while D1 was down']);
    warnings.mockRestore();
  });

  test('a slow D1 does not make the alarm fire again and again while a send to the watchers is out', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const made = await claim(priya);
    const watcher = await watch();
    await watcher.received(1);
    // D1 can't say who is blocked, then takes forever to say it.
    let blocks: 'refused' | 'slow' = 'refused';
    await runInDurableObject(room, (instance) => {
      const live = instance as unknown as { env: Env };
      const answering = {
        prepare: (query: string) => {
          if (!query.includes('donor_blocks')) return db.prepare(query);
          if (blocks === 'refused') throw new Error('D1 is down.');
          const hangs = { bind: () => hangs, all: () => new Promise(() => undefined) };
          return hangs;
        },
      } as unknown as D1Database;
      live.env = { ...live.env, DB: answering };
    });
    at(t0 + MINUTE);
    await post(made, 'while D1 was down');
    expect(await alarmTime()).toBe(t0 + 2 * MINUTE);

    blocks = 'slow';
    at(t0 + 2 * MINUTE);
    await runDurableObjectAlarm(room);

    // The try that is out waits a minute before the alarm tries again.
    expect(await alarmTime()).toBe(t0 + 3 * MINUTE);
    warnings.mockRestore();
  });

  test('a watcher stays connected while the room hibernates, and gets the next event', async () => {
    const made = await claim(priya);
    const watcher = await watch();
    await watcher.received(1);

    await evictDurableObject(room);
    at(t0 + MINUTE);
    await post(made, 'after the nap');

    expect((await watcher.received(2))[1]).toEqual(['update', 'after the nap']);
  });
});

describe('a restart', () => {
  test('keeps the history, the claims, and the cap', async () => {
    const made = await claim(priya);
    await claim(kenji);
    await claim(ana);
    at(t0 + MINUTE);
    await post(made, 'one');
    const before = await room.history();

    await evictDurableObject(room);

    expect(await room.history()).toEqual(before);
    expect(await room.claim(request(ravi))).toMatchObject({ ok: false, refusal: { code: 'issue_full' } });
    const watcher = await watch();
    expect(await watcher.received(4)).toEqual(before.map((e) => [e.kind, e.text]));
  });

  test('keeps the timers', async () => {
    const made = await claim(priya);

    await evictDurableObject(room);
    at(t0 + 30 * MINUTE);
    await runDurableObjectAlarm(room);

    expect(await afterAlarm(made)).toEqual(['paused', 'paused']);
  });
});

describe('the D1 mirror', () => {
  test('D1 follows every change to a claim', async () => {
    const made = await claim(priya);
    const mirrored = async () => {
      const { claims } = await room.snapshot();
      expect(await getClaim(db, made.id)).toEqual(claims.find((c) => c.id === made.id));
    };
    await mirrored();

    at(t0 + MINUTE);
    await post(made, 'one');
    await mirrored();
    at(t0 + HOUR);
    await runDurableObjectAlarm(room);
    expect((await getClaim(db, made.id))?.state).toBe('paused');
    await mirrored();
    at(t0 + 2 * HOUR);
    await post(made, 'two');
    await mirrored();
    await room.submit({ claimId: made.id, githubId: priya.githubId, tokenEstimate: 120_000 });
    await mirrored();
    await room.openPr({ claimId: made.id, githubId: priya.githubId, pr: prRef(61) });
    await mirrored();

    expect(await getClaim(db, made.id)).toMatchObject({ state: 'pr_opened', pr: prRef(61), tokenEstimate: 120_000 });
  });

  test('a save to D1 that fails is sent again by the alarm', async () => {
    // Someone D1 has no record of yet, so the save is refused.
    const newcomer = { githubId: 3099, login: 'newcomer' };
    const made = await claim(newcomer);
    expect(await getClaim(db, made.id)).toBeNull();
    expect(await alarmTime()).toBe(t0 + MINUTE);

    await savePerson(db, newcomer, t0);
    at(t0 + MINUTE);
    await runDurableObjectAlarm(room);

    expect(await getClaim(db, made.id)).toEqual(made);
    expect(await alarmTime()).toBe(t0 + 30 * MINUTE);
  });

  test('a save that keeps failing is tried later and later, up to an hour apart, and given up after a day', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Someone D1 never records, so every save is refused.
    const made = await claim({ githubId: 3098, login: 'drifter' });

    // Run each alarm when it comes, until the room sets none.
    const alarms: number[] = [];
    for (let next = await alarmTime(); next !== null; next = await alarmTime()) {
      if (alarms.length > 100) throw new Error('The room never stopped trying.');
      alarms.push(next - t0);
      at(next);
      await runDurableObjectAlarm(room);
    }

    // Tries at 1, 3, 7, and 15 minutes. The pause at 30 changes the claim,
    // and its last try was over a minute before, so it is tried then too, and
    // then 32 minutes later, and 60 after that.
    expect(alarms.slice(0, 7)).toEqual([1, 3, 7, 15, 30, 62, 122].map((m) => m * MINUTE));
    const gaps = alarms.slice(1).map((time, i) => time - (alarms[i] ?? 0));
    expect(Math.max(...gaps)).toBe(HOUR);
    expect(alarms.at(-1)).toBeGreaterThanOrEqual(DAY);
    expect(await getClaim(db, made.id)).toBeNull();
    // One try when the claim was made, and one at each alarm: every retry,
    // and the pause and the expiry, which change the claim.
    expect(warnings).toHaveBeenCalledTimes(alarms.length + 1);
    const givenUp = errors.mock.calls.filter((call) => String(call[0]).includes(made.id));
    expect(givenUp).toHaveLength(1);
    expect(String(givenUp[0]?.[0])).toContain('gave up');
  });

  test('a change while a save waits for its retry waits too', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const drifter = { githubId: 3096, login: 'drifter-two' };
    const made = await claim(drifter);
    expect(warnings).toHaveBeenCalledTimes(1);

    at(t0 + 10 * SECOND);
    await room.submit({ claimId: made.id, githubId: drifter.githubId });

    expect(warnings).toHaveBeenCalledTimes(1);
    expect(await alarmTime()).toBe(t0 + MINUTE);
  });

  test('a save that is out is not tried again by another call at the same moment', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const made = await claim({ githubId: 3095, login: 'racer' });
    expect(warnings).toHaveBeenCalledTimes(1);

    // Two calls at once, when the save is due. Made inside the room, the
    // first runs until it awaits D1, then the second looks for saves to try
    // while the first one's try is out. Calls through the stub overlap the
    // same way, but only when D1 answers slowly.
    at(t0 + MINUTE);
    await runInDurableObject(room, (instance) => Promise.all([instance.snapshot(), instance.snapshot()]));

    expect(warnings).toHaveBeenCalledTimes(2);
    // One more failed try, so the next waits 2 minutes.
    expect(await alarmTime()).toBe(t0 + 3 * MINUTE);
    expect(await getClaim(db, made.id)).toBeNull();
  });

  test('a change after the room gave up starts the tries over, and they back off and give up again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const wanderer = { githubId: 3097, login: 'wanderer' };
    const made = await claim(wanderer);
    const mine = { claimId: made.id, githubId: wanderer.githubId };
    at(t0 + 10 * SECOND);
    await room.submit(mine);
    const expiry = t0 + 10 * SECOND + 7 * DAY;
    const gaveUp = () => errors.mock.calls.filter((call) => String(call[0]).includes(made.id)).length;
    // Runs each alarm until only the 7-day review window is left.
    const retries = async () => {
      const alarms: number[] = [];
      for (let next = await alarmTime(); next !== null && next !== expiry; next = await alarmTime()) {
        if (alarms.length > 100) throw new Error('The room never stopped trying.');
        alarms.push(next);
        at(next);
        await runDurableObjectAlarm(room);
      }
      return alarms;
    };
    await retries();
    expect(gaveUp()).toBe(1);

    // The change starts the tries over, and D1 still refuses the claim.
    at(t0 + 2 * DAY);
    await room.submit(mine);
    const again = await retries();

    expect(again[0]).toBe(t0 + 2 * DAY + MINUTE);
    const gaps = again.slice(1, 6).map((time, i) => time - (again[i] ?? 0));
    expect(gaps).toEqual([2, 4, 8, 16, 32].map((m) => m * MINUTE));
    expect(gaveUp()).toBe(2);

    // Once D1 can take it, the next change lands.
    await savePerson(db, wanderer, t0);
    at(t0 + 4 * DAY);
    await room.submit(mine);
    expect(await getClaim(db, made.id)).toMatchObject({ id: made.id, state: 'awaiting_review' });
  });

  test('a save that can never land is tried at most once a minute, however busy its room', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stuck = await claim({ githubId: 3092, login: 'stuck' });
    const priyas = await claim(priya);

    // Priya's posts land every 10 seconds for two minutes.
    for (let seconds = 10; seconds <= 120; seconds += 10) {
      at(t0 + seconds * SECOND);
      await post(priyas, `step ${String(seconds / 10)}`);
    }

    const tries = warnings.mock.calls.filter((call) => String(call[0]).includes(stuck.id));
    expect(tries).toHaveLength(3);
  });

  test("when a save lands, the room's other waiting saves, and those it gave up on, are due at once, for the alarm to try", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const early = { githubId: 3094, login: 'early-bird' };
    const late = { githubId: 3093, login: 'late-comer' };
    const earlyClaim = await claim(early);
    // Run every alarm until the room gives up on the save, after the claim expired.
    for (let next = await alarmTime(), runs = 0; next !== null; next = await alarmTime(), runs += 1) {
      if (runs > 100) throw new Error('The room never stopped trying.');
      at(next);
      await runDurableObjectAlarm(room);
    }
    at(t0 + 2 * DAY);
    const lateClaim = await claim(late);
    for (const minutes of [1, 3]) {
      at(t0 + 2 * DAY + minutes * MINUTE);
      await runDurableObjectAlarm(room);
    }
    expect(await alarmTime()).toBe(t0 + 2 * DAY + 7 * MINUTE);

    await savePerson(db, early, t0);
    await savePerson(db, late, t0);
    at(t0 + 2 * DAY + 4 * MINUTE);
    await claim(priya);

    // Priya's claim answers without waiting on the saves it made due.
    expect(await getClaim(db, earlyClaim.id)).toBeNull();
    expect(await alarmTime()).toBe(t0 + 2 * DAY + 4 * MINUTE);
    await runDurableObjectAlarm(room);
    expect(await getClaim(db, earlyClaim.id)).toMatchObject({ state: 'expired' });
    expect(await getClaim(db, lateClaim.id)).toMatchObject({ state: 'active' });
  });

  test("a claimant's change makes their waiting save due a minute after its last try, at the latest", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lateSigner = { githubId: 3091, login: 'late-signer' };
    const made = await claim(lateSigner);
    // Tries fail at 1, 3, 7, 15, and 30 minutes, the last at the pause. The
    // next would wait 32 minutes.
    for (const minutes of [1, 3, 7, 15, 30]) {
      at(t0 + minutes * MINUTE);
      await runDurableObjectAlarm(room);
    }
    expect(await alarmTime()).toBe(t0 + 62 * MINUTE);

    // D1 takes the claim from minute 32, and the claimant posts then.
    await savePerson(db, lateSigner, t0);
    at(t0 + 32 * MINUTE);
    await post(made, 'back on it');

    expect(await getClaim(db, made.id)).toMatchObject({ state: 'active', lastUpdateAt: t0 + 32 * MINUTE });
  });
});

describe('the feed queue', () => {
  test('gets each event once it is stored, with its claimant and project', async () => {
    const queue = await standInQueue();
    const made = await claim(priya);
    at(t0 + MINUTE);
    await post(made, 'reading src/range.ts');

    await vi.waitFor(() => {
      expect(queue.sent).toHaveLength(2);
    });
    const events = await room.history();
    expect(queue.sent).toEqual(events.map((event) => ({ event, githubId: priya.githubId, project: repo })));
    expect(await unsent()).toEqual([]);
  });

  test('a queue that is down fails no call, and the alarm sends its events a minute later, then later and later', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queue = await standInQueue();
    queue.down = true;

    const made = await claim(priya);
    expect(await post(made, 'one')).toMatchObject({ ok: true, posted: true });

    // Each try that fails waits a minute, then twice as long. The post waits
    // behind the claim, which the queue has to take first.
    const tries = async (...expected: number[]) => {
      await vi.waitFor(async () => {
        expect((await unsent()).map((row) => row.tries)).toEqual(expected);
      });
      return runInDurableObject(room, (_, state) => state.storage.getAlarm());
    };
    expect(await tries(1, 0)).toBe(t0 + MINUTE);
    at(t0 + MINUTE);
    await runDurableObjectAlarm(room);
    expect(await tries(2, 1)).toBe(t0 + 3 * MINUTE);
    at(t0 + 3 * MINUTE);
    await runDurableObjectAlarm(room);
    expect(await tries(3, 2)).toBe(t0 + 7 * MINUTE);
    expect(queue.sent).toEqual([]);

    queue.down = false;
    at(t0 + 7 * MINUTE);
    await runDurableObjectAlarm(room);

    await vi.waitFor(() => {
      expect(queue.sent.map((m) => m.event.text)).toEqual(['claimed the issue', 'one']);
    });
    // Nothing is left to send, so the alarm is the claim's pause again.
    expect(await alarmTime()).toBe(t0 + 30 * MINUTE);
    expect(warnings).toHaveBeenCalled();
  });

  test('a batch the queue refuses holds back the events after it, so none reaches the feeds ahead of it', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queue = await standInQueue();
    queue.hang = true;
    // More events than one batch holds, all waiting for their send.
    const made = await claim(priya);
    for (let i = 1; i <= 60; i++) {
      at(t0 + i * 10 * SECOND);
      await post(made, `line ${String(i)}`);
    }
    expect(await unsent()).toHaveLength(61);

    // Every event is due. The first batch is refused, and the second waits.
    queue.hang = false;
    queue.refuseNext = true;
    const before = queue.batches;
    at(t0 + 3 * HOUR);
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => {
      expect(queue.batches).toBe(before + 1);
    });
    await vi.waitFor(async () => {
      expect(await alarmTimeWhileUnsent()).toBeGreaterThan(t0 + 3 * HOUR);
    });
    // The alarm paused the claim, which made one more event.
    const events = await room.history();
    expect(events).toHaveLength(62);
    expect(queue.sent).toEqual([]);
    expect(await unsent()).toHaveLength(events.length);

    at((await alarmTimeWhileUnsent()) ?? 0);
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => {
      expect(queue.sent).toHaveLength(events.length);
    });
    expect(queue.sent.map((m) => m.event.text)).toEqual((await room.history()).map((e) => e.text));
    warnings.mockRestore();
  });

  test("a send that never answers holds up no call, and the alarm sends its event a minute later", async () => {
    const queue = await standInQueue();
    queue.hang = true;

    const made = await claim(priya);

    expect(made.state).toBe('active');
    await vi.waitFor(async () => {
      expect(await runInDurableObject(room, (_, state) => state.storage.getAlarm())).toBe(t0 + MINUTE);
    });
    queue.hang = false;
    at(t0 + MINUTE);
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => {
      expect(queue.sent.map((m) => m.event.kind)).toEqual(['claimed']);
    });
  });
});

describe('a blocked donor', () => {
  test("has their events hidden from the room's watchers, those stored before the block included", async () => {
    const priyas = await claim(priya);
    const kenjis = await claim(kenji);
    at(t0 + MINUTE);
    await post(priyas, 'priya before');
    await post(kenjis, 'kenji before');

    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0 + MINUTE);

    const watcher = await watch();
    expect(await watcher.received(2)).toEqual([
      ['claimed', 'claimed the issue'],
      ['update', 'kenji before'],
    ]);
    expect(watcher.events.every((e) => e.user === 'kenji')).toBe(true);
    at(t0 + 2 * MINUTE);
    await post(priyas, 'priya after');
    await post(kenjis, 'kenji after');
    expect((await watcher.received(3))[2]).toEqual(['update', 'kenji after']);
    // The room keeps every event, and its history leaves hers out too.
    expect((await storedEvents(room)).map((e) => e.text)).toContain('priya after');
    expect((await room.history()).map((e) => e.user)).toEqual(['kenji', 'kenji', 'kenji']);
    // The tests after this one post as her.
    await unblockDonor(db, priya.githubId);
  });
});

describe("an issue whose repo is on the do-not-list", () => {
  test("has every event hidden from the room's watchers, its history, and its glance, and the room still stores them", async () => {
    const priyas = await claim(priya);
    at(t0 + MINUTE);
    await post(priyas, 'priya before');

    await addToDoNotList(db, { repo: repo.toUpperCase(), reason: null, addedBy: admin.githubId }, t0 + MINUTE);

    const watcher = await watch();
    at(t0 + 2 * MINUTE);
    await post(priyas, 'priya after');
    expect(await room.history()).toEqual([]);
    expect((await room.glance())?.events).toEqual([]);
    expect((await storedEvents(room)).map((e) => e.text)).toEqual(['claimed the issue', 'priya before', 'priya after']);
    // Off the list again, a new watcher gets the whole history, and the
    // watcher who was connected gets what comes next.
    await takeOffDoNotList(repo);
    const later = await watch();
    expect((await later.received(3)).map(([, text]) => text)).toEqual(['claimed the issue', 'priya before', 'priya after']);
    at(t0 + 3 * MINUTE);
    await post(priyas, 'priya last');
    expect(await watcher.received(1)).toEqual([['update', 'priya last']]);
  });
});

describe('an issue in a repo two projects keep their issues in', () => {
  test("keeps its events while one of the projects isn't on the do-not-list, and hides them once both are", async () => {
    const shared = 'sample-owner/sample-shared-issues';
    const removed = 'sample-owner/sample-removed-code';
    const stays = 'sample-owner/sample-staying-code';
    for (const code of [removed, stays]) {
      await createProject(
        db,
        {
          repo: code,
          status: 'approved',
          source: 'registered',
          policy: null,
          settings: { tags: ['help wanted'], issueRepo: shared },
          addedBy: admin.githubId,
        },
        t0,
      );
    }
    const sharedIssue = `${shared}#1`;
    const sharedRoom = issueRoom(env.ISSUE_ROOM, sharedIssue);
    claimOf(await sharedRoom.claim(request(priya, { issue: sharedIssue, project: stays })));

    await addToDoNotList(db, { repo: removed, reason: null, addedBy: admin.githubId }, t0 + MINUTE);
    const oneRemoved = [(await sharedRoom.history()).length, (await sharedRoom.glance())?.events.length];
    await addToDoNotList(db, { repo: stays, reason: null, addedBy: admin.githubId }, t0 + MINUTE);
    const bothRemoved = [(await sharedRoom.history()).length, (await sharedRoom.glance())?.events.length];

    expect(oneRemoved).toEqual([1, 1]);
    expect(bothRemoved).toEqual([0, 0]);
  });
});

describe('submitting, opening the PR, and releasing', () => {
  test('only the claimant can submit, open the PR, or release', async () => {
    const made = await claim(priya);
    const other = { claimId: made.id, githubId: kenji.githubId };

    const results = [
      await room.submit(other),
      await room.openPr({ ...other, pr: prRef(62) }),
      await room.release({ ...other, reason: 'not mine' }),
    ];

    for (const result of results) expect(result).toMatchObject({ ok: false, refusal: { code: 'not_claim_owner' } });
    expect(await stateOf(made)).toBe('active');
  });

  test("each submit adds its token estimate to the claim's", async () => {
    const made = await claim(priya);
    const mine = { claimId: made.id, githubId: priya.githubId };

    await room.submit({ ...mine, tokenEstimate: 90_000 });
    await room.submit(mine);
    const last = await room.submit({ ...mine, tokenEstimate: 30_000 });

    expect(last).toMatchObject({ ok: true, claim: { state: 'awaiting_review', tokenEstimate: 120_000 } });
    const texts = (await room.history()).map((e) => e.text);
    expect(texts).toEqual(['claimed the issue', 'submitted the work', 'submitted more work', 'submitted more work']);
  });

  test('a PR opens only for submitted work', async () => {
    const made = await claim(priya);

    const result = await room.openPr({ claimId: made.id, githubId: priya.githubId, pr: prRef(63) });

    expect(result).toMatchObject({ ok: false, refusal: { code: 'not_submitted' } });
    expect(await room.claim(request(kenji))).toMatchObject({ ok: true });
  });
});
