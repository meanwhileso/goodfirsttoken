import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { getClaim, savePerson } from '../../src/db';
import { issueRoom } from '../../src/rooms/issue-room';
import { db, repo, sha } from '../db/helpers';

// A room whose call dies while its save to D1 is out. Every person and repo
// here is made up.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const t0 = Date.UTC(2100, 0, 4, 12, 0, 0);
const priya = { githubId: 3001, login: 'priya' };
const issue = `${repo}#700`;
const pr = { repo, number: 701, url: `https://github.com/${repo}/pull/701` };

// A D1 binding whose queries never answer.
const silentDb = {
  prepare() {
    const statement = {
      bind: () => statement,
      run: () => new Promise(() => undefined),
      first: () => new Promise(() => undefined),
      all: () => new Promise(() => undefined),
    };
    return statement;
  },
};

afterEach(() => {
  vi.useRealTimers();
});

test('a change whose save was out when its call died is saved by the alarm a minute later', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t0);
  await savePerson(db, priya, t0);
  const room = issueRoom(env.ISSUE_ROOM, issue);
  const claimed = await room.claim({
    issue,
    project: repo,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    slots: 3,
  });
  if (!claimed.ok) throw new Error(claimed.refusal.message);
  const mine = { claimId: claimed.claim.id, githubId: priya.githubId };
  vi.setSystemTime(t0 + HOUR);
  await room.submit(mine);
  await room.openPr({ ...mine, pr });
  // A claim with an open PR has no timer, and D1 has it, so no alarm is set.
  expect(await runInDurableObject(room, (_, state) => state.storage.getAlarm())).toBeNull();

  // The running room's saves to D1 never answer from here. Aborting the
  // room ends the call, and the room comes back with its real D1.
  await runInDurableObject(room, (instance) => {
    const live = instance as unknown as { env: Env };
    live.env = new Proxy(live.env, {
      get: (target, key) => (key === 'DB' ? silentDb : (Reflect.get(target, key) as unknown)),
    });
  });
  vi.setSystemTime(t0 + 2 * HOUR);
  const dying = room.postUpdate({ ...mine, text: 'answered the review' }).catch(() => undefined);
  // The post is stored before its save goes out.
  const posted = await vi.waitFor(async () => {
    const last = (await room.history()).at(-1);
    expect(last?.text).toBe('answered the review');
    return Date.parse(last?.time ?? '');
  });
  // D1 still has the claim from before the post.
  expect(await getClaim(db, claimed.claim.id)).toMatchObject({ state: 'pr_opened', lastUpdateAt: t0 });
  await abortAllDurableObjects();
  await dying;

  // A stub stops working when its object is aborted, so this takes a new one.
  const restarted = issueRoom(env.ISSUE_ROOM, issue);
  expect(await runInDurableObject(restarted, (_, state) => state.storage.getAlarm())).toBe(posted + MINUTE);
  vi.setSystemTime(posted + MINUTE);
  await runDurableObjectAlarm(restarted);
  expect(await getClaim(db, claimed.claim.id)).toMatchObject({ state: 'pr_opened', lastUpdateAt: posted });
});
