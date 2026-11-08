import { newClaim, type ClaimRecord } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import { listPrFollowUps, saveClaim, saveFollowUps, setProjectStatus, sortFollowUps } from '../../src/db';
import { admin, db, emptyDatabase, HOUR, kenji, maintainer, MINUTE, priya, registeredProject, repo, sha, signIn, t0 } from './helpers';

// The follow-ups /me shows of each open PR: those that wait for the donor,
// with the agent's question, and the latest of the rest. The people, repo,
// and comments are made up.

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

/** A maintainer's review, written `minutes` after t0. */
function review(commentId: string, minutes: number, body = `Review ${commentId}.`) {
  return {
    commentId,
    kind: 'review' as const,
    reviewer: maintainer.login,
    authorKind: 'maintainer' as const,
    body,
    path: null,
    url: `https://github.com/${repo}/pull/57#pullrequestreview-${commentId}`,
    writtenAt: t0 + minutes * MINUTE,
  };
}

const ids = (records: readonly { commentId: string }[] | undefined) => (records ?? []).map((f) => f.commentId);
const limits = { waiting: 20, latest: 3 };

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, maintainer, admin);
  await registeredProject();
  await saveClaim(db, openedClaim('c_1', 57), 1);
  await saveClaim(db, openedClaim('c_2', 58, kenji), 1);
});

describe('the follow-ups /me shows of a PR', () => {
  test('every one that waits for the donor shows, oldest first, with the newest of the rest by when each settled, or else was written', async () => {
    await saveFollowUps(db, 'c_1', ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((key, i) => review(key, i)), t0 + HOUR);
    await sortFollowUps(
      db,
      'c_1',
      [
        { followUpId: 'r5', state: 'waiting_donor', question: 'Cover the admin feed too?' },
        { followUpId: 'r2', state: 'waiting_donor', question: 'Add a second test?' },
        { followUpId: 'r3', state: 'settled', outcome: 'no_change' },
      ],
      t0 + 2 * HOUR,
    );
    await sortFollowUps(db, 'c_1', [{ followUpId: 'r1', state: 'settled', outcome: 'resolved' }], t0 + 3 * HOUR);

    const shown = await listPrFollowUps(db, ['c_1'], limits);

    expect(ids(shown.get('c_1')?.waiting)).toEqual(['r2', 'r5']);
    expect(shown.get('c_1')?.waiting[0]?.question).toBe('Add a second test?');
    // r1 settled last, so it is the newest though it was written first. Of
    // those that never settled, r6 was written last.
    expect(ids(shown.get('c_1')?.latest)).toEqual(['r1', 'r3', 'r6']);
  });

  test('shows only the claims it is given, and none for a claim with no follow-up', async () => {
    await saveFollowUps(db, 'c_1', [review('r1', 0)], t0 + HOUR);
    await saveFollowUps(db, 'c_2', [review('k1', 0)], t0 + HOUR);

    const shown = await listPrFollowUps(db, ['c_1'], limits);
    const none = await listPrFollowUps(db, [], limits);

    expect([...shown.keys()]).toEqual(['c_1']);
    expect(none.size).toBe(0);
  });

  test("a PR whose project doesn't ask for help now shows none, as the tools list none", async () => {
    await saveFollowUps(db, 'c_1', [review('r1', 0)], t0 + HOUR);
    await sortFollowUps(db, 'c_1', [{ followUpId: 'r1', state: 'waiting_donor', question: 'Go on?' }], t0 + 2 * HOUR);

    await setProjectStatus(db, repo, { status: 'paused', reason: null, changedBy: maintainer.githubId }, t0 + 3 * HOUR);

    expect((await listPrFollowUps(db, ['c_1'], limits)).size).toBe(0);
  });
});
