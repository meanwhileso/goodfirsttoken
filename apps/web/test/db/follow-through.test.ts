import { newClaim, type ClaimRecord } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  addPr,
  getFollowMode,
  giveToWake,
  listPrFollowModes,
  listStoppedWakes,
  listWakes,
  recordWakeRun,
  saveClaim,
  saveFollowThrough,
  setPrState,
  type NewWake,
} from '../../src/db';
import { DAY, db, emptyDatabase, HOUR, kenji, MINUTE, priya, repo, sha, signIn, t0 } from './helpers';

// The donor's follow-through mode, for all their PRs and for one, and their
// wakes: what each was given, when each last ran, and which stopped. The
// people, repo, and PRs are made up.

function prRef(number: number) {
  return { repo, number, url: `https://github.com/${repo}/pull/${String(number)}` };
}

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
    pr: prRef(number),
  };
}

const desktop = { harness: 'claude-code-desktop', level: 'full', intervalMinutes: 15 } as const;

const setMode = (person: number, mode: 'go_ahead' | 'ask_first', at = t0) => saveFollowThrough(db, person, { mode: { mode } }, at);
const setPrMode = (claimId: string, mode: 'go_ahead' | 'ask_first' | 'off', at = t0) =>
  saveFollowThrough(db, claimId === 'c_3' ? kenji.githubId : priya.githubId, { mode: { mode, claimId } }, at);
const changeWakes = (person: number, change: { remove?: string; save?: NewWake }, at: number) => saveFollowThrough(db, person, change, at);

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji);
  await saveClaim(db, openedClaim('c_1', 57), 1);
  await saveClaim(db, openedClaim('c_2', 58), 1);
  await saveClaim(db, openedClaim('c_3', 59, kenji), 1);
});

describe("the donor's mode", () => {
  test('a donor who never chose follows go_ahead, and one who chose keeps their choice', async () => {
    const before = await getFollowMode(db, priya.githubId);
    await setMode(priya.githubId, 'ask_first');

    expect(before).toEqual({ mode: 'go_ahead', chosen: false });
    expect(await getFollowMode(db, priya.githubId)).toEqual({ mode: 'ask_first', chosen: true });
    expect(await getFollowMode(db, kenji.githubId)).toEqual({ mode: 'go_ahead', chosen: false });
  });

  test("a mode for all the donor's PRs takes the place of each PR's own, and a PR the donor stopped following stays off", async () => {
    await setPrMode('c_1', 'ask_first');
    await setPrMode('c_2', 'off');
    await setPrMode('c_3', 'ask_first');
    const own = await listPrFollowModes(db, priya.githubId);

    await setMode(priya.githubId, 'go_ahead', t0 + HOUR);

    expect(own).toEqual(new Map([['c_1', 'ask_first'], ['c_2', 'off']]));
    expect(await listPrFollowModes(db, priya.githubId)).toEqual(new Map([['c_2', 'off']]));
    expect(await listPrFollowModes(db, kenji.githubId)).toEqual(new Map([['c_3', 'ask_first']]));
  });

  test("one PR's mode changes again, and only that PR's", async () => {
    await setPrMode('c_1', 'off');
    await setPrMode('c_1', 'go_ahead', t0 + HOUR);

    expect(await listPrFollowModes(db, priya.githubId)).toEqual(new Map([['c_1', 'go_ahead']]));
  });
});

describe('wakes', () => {
  test("a saved wake lists with no run yet, and a run records its time on the donor's own wake alone", async () => {
    const { saved } = await changeWakes(priya.githubId, { save: desktop }, t0);
    if (saved === null) throw new Error('no wake saved');
    const kenjis = await recordWakeRun(db, kenji.githubId, saved.id, t0 + MINUTE);
    const ran = await recordWakeRun(db, priya.githubId, saved.id, t0 + 2 * MINUTE);

    expect(saved).toEqual({ id: expect.stringMatching(/^w_/) as string, githubId: priya.githubId, ...desktop, createdAt: t0, lastRunAt: null, trigger: null });
    expect(kenjis).toBeNull();
    expect(ran).toEqual({ ...saved, lastRunAt: t0 + 2 * MINUTE });
    expect(await listWakes(db, priya.githubId)).toEqual([ran]);
    expect(await listWakes(db, kenji.githubId)).toEqual([]);
  });

  test("a run that lands after a later one keeps the later one's time", async () => {
    const { saved } = await changeWakes(priya.githubId, { save: desktop }, t0);
    if (saved === null) throw new Error('no wake saved');
    await recordWakeRun(db, priya.githubId, saved.id, t0 + 2 * HOUR);
    await recordWakeRun(db, priya.githubId, saved.id, t0 + HOUR);

    expect((await listWakes(db, priya.githubId))[0]?.lastRunAt).toBe(t0 + 2 * HOUR);
  });

  test("removing a wake takes it and what it was given, removing another donor's changes nothing, and a removal and a save go together", async () => {
    const { saved: first } = await changeWakes(priya.githubId, { save: desktop }, t0);
    if (first === null) throw new Error('no wake saved');
    await giveToWake(db, first.id, [{ claimId: 'c_1', followUpId: 'PRR_1' }], t0);

    const byKenji = await changeWakes(kenji.githubId, { remove: first.id }, t0 + HOUR);
    const replaced = await changeWakes(priya.githubId, { remove: first.id, save: { ...desktop, intervalMinutes: 30 } }, t0 + HOUR);

    expect(byKenji).toEqual({ removed: false, saved: null, wentOn: false });
    expect(replaced).toEqual({ removed: true, saved: expect.objectContaining({ intervalMinutes: 30 }) as unknown, wentOn: false });
    expect((await listWakes(db, priya.githubId)).map((wake) => wake.intervalMinutes)).toEqual([30]);
    const given = await db.prepare('SELECT COUNT(*) AS n FROM wake_follow_ups WHERE wake_id = ?').bind(first.id).first<number>('n');
    expect(given).toBe(0);
  });

  test('a donor keeps at most 10 wakes: a change that saves an 11th changes nothing, its mode neither, and one that removes a wake saves it', async () => {
    const ten: string[] = [];
    for (let i = 0; i < 10; i++) ten.push((await changeWakes(priya.githubId, { save: desktop }, t0 + i)).saved?.id ?? '');

    const eleventh = await saveFollowThrough(db, priya.githubId, { mode: { mode: 'ask_first' }, save: desktop }, t0 + HOUR);
    const kept = { wakes: (await listWakes(db, priya.githubId)).length, mode: await getFollowMode(db, priya.githubId) };
    const swapped = await saveFollowThrough(db, priya.githubId, { mode: { mode: 'ask_first' }, remove: ten[0], save: desktop }, t0 + HOUR);

    expect(eleventh).toEqual({ removed: false, saved: null, wentOn: false });
    expect(kept).toEqual({ wakes: 10, mode: { mode: 'go_ahead', chosen: false } });
    expect(swapped).toMatchObject({ removed: true, saved: { createdAt: t0 + HOUR } });
    expect((await listWakes(db, priya.githubId)).map((wake) => wake.id)).not.toContain(ten[0]);
    expect(await listWakes(db, priya.githubId)).toHaveLength(10);
    expect(await getFollowMode(db, priya.githubId)).toEqual({ mode: 'ask_first', chosen: true });
  });

  test('each wake is given a follow-up once, and another wake is given it too', async () => {
    const { saved: one } = await changeWakes(priya.githubId, { save: desktop }, t0);
    const { saved: two } = await changeWakes(priya.githubId, { save: { harness: 'chatgpt', level: 'notify', intervalMinutes: 60 } }, t0);
    if (one === null || two === null) throw new Error('no wake saved');
    const keys = [
      { claimId: 'c_1', followUpId: 'PRR_1' },
      { claimId: 'c_1', followUpId: 'PRR_2' },
      { claimId: 'c_2', followUpId: 'PRR_1' },
    ];
    const first = await giveToWake(db, one.id, keys.slice(0, 2), t0);
    const again = await giveToWake(db, one.id, keys, t0 + HOUR);

    expect(first).toEqual(keys.slice(0, 2));
    expect(again).toEqual([keys[2]]);
    expect(await giveToWake(db, one.id, keys, t0 + 2 * HOUR)).toEqual([]);
    expect(await giveToWake(db, two.id, keys, t0 + 2 * HOUR)).toEqual(keys);
  });
});

describe('a wake that stopped', () => {
  async function wake(at = t0) {
    const { saved } = await changeWakes(priya.githubId, { save: desktop }, at);
    if (saved === null) throw new Error('no wake saved');
    return saved;
  }

  test("a wake with no run for 24 hours past its interval while one of the donor's PRs is open stopped, with when it last ran", async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    const saved = await wake();
    await recordWakeRun(db, priya.githubId, saved.id, t0 + HOUR);
    const due = t0 + HOUR + 15 * MINUTE + DAY;

    expect(await listStoppedWakes(db, priya.githubId, due - 1)).toEqual([]);
    expect(await listStoppedWakes(db, priya.githubId, due)).toEqual([{ ...saved, lastRunAt: t0 + HOUR }]);
    expect(await listStoppedWakes(db, kenji.githubId, t0 + 2 * DAY)).toEqual([]);
  });

  test('a wake that never ran stopped 24 hours after it was saved', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    const saved = await wake();

    expect(await listStoppedWakes(db, priya.githubId, t0 + 15 * MINUTE + DAY - 1)).toEqual([]);
    expect(await listStoppedWakes(db, priya.githubId, t0 + 15 * MINUTE + DAY)).toEqual([saved]);
  });

  test('a daily wake that runs a little late is not stopped, and a session wake never is, since it runs only in a session', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    const { saved: daily } = await changeWakes(priya.githubId, { save: { harness: 'grok-automations', level: 'notify', intervalMinutes: 1440 } }, t0);
    await changeWakes(priya.githubId, { save: { harness: 'claude-code-terminal', level: 'session', intervalMinutes: 15 } }, t0);

    expect(await listStoppedWakes(db, priya.githubId, t0 + DAY + HOUR)).toEqual([]);
    expect(await listStoppedWakes(db, priya.githubId, t0 + 2 * DAY)).toEqual([daily]);
  });

  test('with no PR of the donor open, no wake stopped', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await addPr(db, { claimId: 'c_3', pr: prRef(59), openedAt: t0 });
    await wake();
    await setPrState(db, 'c_1', 'merged', t0 + HOUR);

    expect(await listStoppedWakes(db, priya.githubId, t0 + 2 * DAY)).toEqual([]);
  });
});
