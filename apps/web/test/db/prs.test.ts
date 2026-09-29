import type { D1Migration } from 'cloudflare:test';
import { newClaim, type ClaimRecord } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  addPr,
  addToDoNotList,
  blockDonor,
  countProjectPrs,
  createSession,
  getPr,
  listOpenPrs,
  saveClaim,
  setPrState,
  takeMergedToOffer,
  unblockDonor,
} from '../../src/db';
import { admin, DAY, db, emptyDatabase, HOUR, kenji, priya, refusal, repo, sha, signIn, t0, takeOffDoNotList } from './helpers';

function prRef(number: number) {
  return { repo, number, url: `https://github.com/${repo}/pull/${String(number)}` };
}

/** A claim the room holds as pr_opened, with its PR. */
function openedClaim(claimId: string, number: number): ClaimRecord {
  return {
    id: claimId,
    issue: `${repo}#${String(number - 40)}`,
    project: repo,
    githubId: priya.githubId,
    login: priya.login,
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

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya);
  await saveClaim(db, openedClaim('c_1', 57), 1);
  await saveClaim(db, openedClaim('c_2', 58), 1);
});

describe('PRs', () => {
  test("a claim's PR is recorded as open", async () => {
    const added = await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 2 * HOUR });

    expect(added).toEqual({
      claimId: 'c_1',
      pr: prRef(57),
      state: 'open',
      openedAt: t0 + 2 * HOUR,
      mergedAt: null,
      closedAt: null,
    });
    expect(await getPr(db, 'c_1')).toEqual(added);
    expect(await getPr(db, 'c_2')).toBeNull();
  });

  test('recording the same PR again keeps the first record', async () => {
    const first = await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 2 * HOUR });

    expect(await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 3 * HOUR })).toEqual(first);
  });

  test("a claim's PR is the one the claim records, and can't be swapped for another", async () => {
    const message = await refusal(addPr(db, { claimId: 'c_1', pr: prRef(59), openedAt: t0 + 2 * HOUR }));
    expect(message).toContain(`records ${repo}#57`);
    expect(await getPr(db, 'c_1')).toBeNull();

    await saveClaim(db, { ...openedClaim('c_3', 60), state: 'awaiting_review', pr: null }, 1);
    await addPr(db, { claimId: 'c_3', pr: prRef(60), openedAt: t0 + 2 * HOUR });

    await refusal(addPr(db, { claimId: 'c_3', pr: prRef(61), openedAt: t0 + 3 * HOUR }));
    expect((await getPr(db, 'c_3'))?.pr).toEqual(prRef(60));
  });

  test('a PR belongs to one claim', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 2 * HOUR });
    await saveClaim(db, { ...openedClaim('c_3', 60), state: 'awaiting_review', pr: null }, 1);

    const message = await refusal(addPr(db, { claimId: 'c_3', pr: prRef(57), openedAt: t0 + 2 * HOUR }));

    expect(message).toContain('already recorded for claim c_1');
    expect(await getPr(db, 'c_3')).toBeNull();
  });

  test('a merged PR records when it merged and when it closed, and stays merged', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });

    const merged = await setPrState(db, 'c_1', 'merged', t0 + DAY);

    expect(merged).toMatchObject({ state: 'merged', mergedAt: t0 + DAY, closedAt: t0 + DAY });
    expect(await setPrState(db, 'c_1', 'closed', t0 + 2 * DAY)).toEqual(merged);
    expect(await setPrState(db, 'c_1', 'open', t0 + 2 * DAY)).toEqual(merged);
    expect(await getPr(db, 'c_1')).toEqual(merged);
  });

  test("a PR's times change only when its state does", async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await setPrState(db, 'c_1', 'closed', t0 + DAY);

    const again = await setPrState(db, 'c_1', 'closed', t0 + 2 * DAY);

    expect(again).toMatchObject({ state: 'closed', mergedAt: null, closedAt: t0 + DAY });
  });

  test('a reopened PR is open again, with no close time', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await setPrState(db, 'c_1', 'closed', t0 + DAY);

    expect(await setPrState(db, 'c_1', 'open', t0 + 2 * DAY)).toMatchObject({ state: 'open', closedAt: null });
  });

  test('a merge or close time before the PR opened counts as the time it opened, since clocks differ', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + DAY });

    const merged = await setPrState(db, 'c_1', 'merged', t0);

    expect(merged).toMatchObject({ state: 'merged', mergedAt: t0 + DAY, closedAt: t0 + DAY });
  });

  test('the job that follows PRs sees the open ones, oldest first', async () => {
    await addPr(db, { claimId: 'c_2', pr: prRef(58), openedAt: t0 + HOUR });
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });

    expect((await listOpenPrs(db)).map((p) => p.claimId)).toEqual(['c_1', 'c_2']);

    await setPrState(db, 'c_1', 'merged', t0 + DAY);

    expect((await listOpenPrs(db)).map((p) => p.claimId)).toEqual(['c_2']);
  });

  test("a project's PR counts are its claims' open PRs and merged PRs, and a closed PR counts in neither", async () => {
    await saveClaim(db, openedClaim('c_3', 59), 1);
    await saveClaim(db, { ...openedClaim('c_4', 60), project: 'sample-owner/sample-tools' }, 1);
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await addPr(db, { claimId: 'c_2', pr: prRef(58), openedAt: t0 });
    await addPr(db, { claimId: 'c_3', pr: prRef(59), openedAt: t0 });
    await addPr(db, { claimId: 'c_4', pr: prRef(60), openedAt: t0 });
    await setPrState(db, 'c_2', 'merged', t0 + DAY);
    await setPrState(db, 'c_3', 'closed', t0 + DAY);

    expect(await countProjectPrs(db, repo.toUpperCase())).toEqual({ open: 1, merged: 1 });
    expect(await countProjectPrs(db, 'sample-owner/sample-tools')).toEqual({ open: 1, merged: 0 });
    expect(await countProjectPrs(db, 'sample-owner/nothing-here')).toEqual({ open: 0, merged: 0 });
  });

  test('a claim with no PR has no state to set', async () => {
    expect(await setPrState(db, 'c_1', 'merged', t0 + DAY)).toBeNull();
  });
});

describe('merged PRs offered to share', () => {
  beforeEach(async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 2 * HOUR });
    await addPr(db, { claimId: 'c_2', pr: prRef(58), openedAt: t0 + 2 * HOUR });
  });

  test('a merged PR is offered to its donor once, and an open or closed one never', async () => {
    await setPrState(db, 'c_1', 'merged', t0 + DAY);
    await saveClaim(db, openedClaim('c_3', 59), 1);
    await addPr(db, { claimId: 'c_3', pr: prRef(59), openedAt: t0 + 2 * HOUR });
    await setPrState(db, 'c_3', 'closed', t0 + DAY);

    const first = await takeMergedToOffer(db, priya.githubId, t0 + 2 * DAY);
    const again = await takeMergedToOffer(db, priya.githubId, t0 + 3 * DAY);

    expect(first).toEqual([
      { claimId: 'c_1', issue: `${repo}#17`, pr: prRef(57), agent: 'claude-code', title: null, mergedAt: t0 + DAY },
    ]);
    expect(again).toEqual([]);
    expect(await takeMergedToOffer(db, kenji.githubId, t0 + 2 * DAY)).toEqual([]);
  });

  test("a blocked donor's merged PR, and one the do-not-list names, is not offered, and waits until neither holds", async () => {
    await signIn(admin);
    await setPrState(db, 'c_1', 'merged', t0 + DAY);
    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0 + DAY);
    const whileBlocked = await takeMergedToOffer(db, priya.githubId, t0 + 2 * DAY);
    await unblockDonor(db, priya.githubId);
    await addToDoNotList(db, { repo, reason: null, addedBy: admin.githubId }, t0 + 2 * DAY);
    const whileListed = await takeMergedToOffer(db, priya.githubId, t0 + 3 * DAY);
    await takeOffDoNotList(repo);

    expect([whileBlocked, whileListed]).toEqual([[], []]);
    expect(await takeMergedToOffer(db, priya.githubId, t0 + 4 * DAY)).toMatchObject([{ claimId: 'c_1' }]);
  });

  test('the migration that brought the offer counts a PR that merged before its donor started a session as offered', async () => {
    await setPrState(db, 'c_1', 'merged', t0 + DAY);
    await setPrState(db, 'c_2', 'merged', t0 + 3 * DAY);
    await createSession(db, { githubId: priya.githubId, agent: 'claude-code', budget: { kind: 'until_limit' } }, t0 + 2 * DAY);
    const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
    const migration = TEST_MIGRATIONS.find((m) => m.name === '0010_follow_ups.sql');
    // The table and the column are there already, so only the rows it writes run again.
    const writes = migration?.queries.filter((query) => /^\s*UPDATE\b/i.test(query)) ?? [];

    for (const query of writes) await db.prepare(query).run();

    expect(writes).toHaveLength(1);
    expect(await takeMergedToOffer(db, priya.githubId, t0 + 4 * DAY)).toMatchObject([{ claimId: 'c_2' }]);
  });
});
