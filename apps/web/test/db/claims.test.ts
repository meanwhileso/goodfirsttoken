import { newClaim, nextClaimState, type ClaimEvent, type ClaimRecord } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  addPr,
  countWorkingClaims,
  getClaim,
  getPr,
  listIssueClaims,
  listPersonClaims,
  savePerson,
  saveClaim,
} from '../../src/db';
import { db, DAY, emptyDatabase, HOUR, kenji, MINUTE, priya, refusal, repo, sha, signIn, t0 } from './helpers';

const issue = `${repo}#18`;

function prRef(number: number) {
  return { repo, number, url: `https://github.com/${repo}/pull/${String(number)}` };
}
const pr = prRef(57);

/** A new claim, as the issue room makes it. */
function claim(changes: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    id: 'c_1',
    issue,
    project: repo,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    tokenEstimate: null,
    ...newClaim(changes.claimedAt ?? t0),
    ...changes,
  };
}

/** The claim after an event the room accepted. */
function after(record: ClaimRecord, event: ClaimEvent, now: number): ClaimRecord {
  const result = nextClaimState(record, event, now);
  if (!result.ok) throw new Error(result.refusal.message);
  return result.claim;
}

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji);
});

describe('the claims mirror', () => {
  test('a claim is stored with everything the issue room holds', async () => {
    const made = claim({ agent: 'codex', ownProject: true });

    expect(await saveClaim(db, made, 1)).toBe(true);

    expect(await getClaim(db, 'c_1')).toEqual(made);
    expect(await getClaim(db, 'c_2')).toBeNull();
  });

  test('saving a claim again updates its timeline, its PR, and its token estimate', async () => {
    const made = claim();
    await saveClaim(db, made, 1);
    const submitted = { ...after(made, { kind: 'submit' }, t0 + HOUR), tokenEstimate: 180_000 };
    await saveClaim(db, submitted, 2);
    const opened = after(submitted, { kind: 'open_pr', pr }, t0 + 2 * HOUR);

    expect(await saveClaim(db, opened, 3)).toBe(true);

    expect(await getClaim(db, 'c_1')).toEqual(opened);
    expect(opened).toMatchObject({ state: 'pr_opened', submittedAt: t0 + HOUR, pr, tokenEstimate: 180_000 });
  });

  test('a released claim keeps its public reason', async () => {
    const released = after(claim(), { kind: 'release', reason: 'stuck on the lock screen tests' }, t0 + HOUR);

    await saveClaim(db, released, 1);

    expect(await getClaim(db, 'c_1')).toMatchObject({ state: 'released', releaseReason: 'stuck on the lock screen tests' });
  });

  test('a stale save changes nothing', async () => {
    const made = claim();
    await saveClaim(db, made, 1);
    const updated = after(made, { kind: 'update' }, t0 + MINUTE);
    const released = after(updated, { kind: 'release', reason: 'the tests need a GPU' }, t0 + HOUR);
    await saveClaim(db, released, 3);

    // The update, saved as revision 2, arrives after the release.
    expect(await saveClaim(db, updated, 2)).toBe(false);
    // A queue can deliver the same save twice.
    expect(await saveClaim(db, released, 3)).toBe(false);

    expect(await getClaim(db, 'c_1')).toEqual(released);
  });

  test('a stale save changes nothing, whatever PR it names', async () => {
    const submitted = after(claim(), { kind: 'submit' }, t0 + HOUR);
    await saveClaim(db, submitted, 1);
    await addPr(db, { claimId: 'c_1', pr: prRef(60), openedAt: t0 + 2 * HOUR });
    const opened = after(submitted, { kind: 'open_pr', pr: prRef(60) }, t0 + 2 * HOUR);
    await saveClaim(db, opened, 3);

    const updated = after(submitted, { kind: 'update' }, t0 + HOUR + MINUTE);
    expect(await saveClaim(db, updated, 2)).toBe(false);
    const otherPr = after(submitted, { kind: 'open_pr', pr: prRef(61) }, t0 + HOUR + MINUTE);
    expect(await saveClaim(db, otherPr, 2)).toBe(false);

    expect(await getClaim(db, 'c_1')).toEqual(opened);
  });

  test.each([
    ['issue', { issue: `${repo}#19` }],
    ['claimant', { githubId: kenji.githubId, login: kenji.login }],
    ['project', { project: 'sample-owner/other-app' }],
    ['login', { login: 'priya-dev' }],
    ['agent', { agent: 'codex' }],
    ['own-project flag', { ownProject: true }],
    ['start commit', { startCommit: '0123456789abcdef0123456789abcdef01234567' }],
    ['claim time', { claimedAt: t0 + 1 }],
  ])("a stored claim's %s never changes, and a newer save that changes it is refused", async (_, change) => {
    await saveClaim(db, claim(), 1);

    const message = await refusal(saveClaim(db, claim(change), 2));

    expect(message).toContain('already stored with a different');
    expect(await getClaim(db, 'c_1')).toEqual(claim());
  });

  test('a stale save that changes a fixed field is refused too, since it shows a bug', async () => {
    await saveClaim(db, claim(), 2);

    expect(await refusal(saveClaim(db, claim({ agent: 'codex' }), 1))).toContain('already stored with a different');
  });

  test("a claim's PR is the one recorded for it in the PRs table", async () => {
    const submitted = after(claim(), { kind: 'submit' }, t0 + HOUR);
    await saveClaim(db, submitted, 1);
    await addPr(db, { claimId: 'c_1', pr: prRef(60), openedAt: t0 + 2 * HOUR });

    const other = after(submitted, { kind: 'open_pr', pr: prRef(61) }, t0 + 2 * HOUR);
    const message = await refusal(saveClaim(db, other, 2));

    expect(message).toContain(`records ${repo}#60`);
    expect(await getClaim(db, 'c_1')).toEqual(submitted);
    expect((await getPr(db, 'c_1'))?.pr).toEqual(prRef(60));

    const same = after(submitted, { kind: 'open_pr', pr: prRef(60) }, t0 + 2 * HOUR);
    expect(await saveClaim(db, same, 3)).toBe(true);
    expect((await getClaim(db, 'c_1'))?.pr).toEqual(prRef(60));
  });

  test('a newer save lands while the room has not recorded the PR yet', async () => {
    // The PR is recorded before the room saves pr_opened, and an update lands in between.
    const submitted = after(claim(), { kind: 'submit' }, t0 + HOUR);
    await saveClaim(db, submitted, 1);
    await addPr(db, { claimId: 'c_1', pr: prRef(60), openedAt: t0 + 2 * HOUR });

    const updated = after(submitted, { kind: 'update' }, t0 + 2 * HOUR + MINUTE);

    expect(await saveClaim(db, updated, 2)).toBe(true);
    expect(await getClaim(db, 'c_1')).toEqual(updated);
  });

  test('a claim that breaks the claim rules is refused before it reaches the database, naming the field', async () => {
    const message = await refusal(saveClaim(db, claim({ state: 'pr_opened', submittedAt: t0 + HOUR }), 1));

    expect(message).toContain('pr: is required for a claim with an open PR');
    expect(await getClaim(db, 'c_1')).toBeNull();
  });

  test('a claim is made by someone who has signed in', async () => {
    await refusal(saveClaim(db, claim({ githubId: 4040, login: 'nobody-yet' }), 1));

    expect(await getClaim(db, 'c_1')).toBeNull();
  });

  test('the claims on an issue come back in the order they were made', async () => {
    await saveClaim(db, claim({ id: 'c_2', githubId: kenji.githubId, login: kenji.login, claimedAt: t0 + HOUR }), 1);
    await saveClaim(db, claim({ id: 'c_1' }), 1);
    await saveClaim(db, claim({ id: 'c_3', issue: `${repo}#19` }), 1);

    expect((await listIssueClaims(db, issue)).map((c) => c.id)).toEqual(['c_1', 'c_2']);
    expect(await listIssueClaims(db, `${repo}#20`)).toEqual([]);
  });

  test("a person's claims come back newest first, and stay theirs when their login changes", async () => {
    await saveClaim(db, claim({ id: 'c_1' }), 1);
    await saveClaim(db, claim({ id: 'c_2', issue: `${repo}#19`, claimedAt: t0 + DAY }), 1);
    await saveClaim(db, claim({ id: 'c_3', githubId: kenji.githubId, login: kenji.login }), 1);
    await savePerson(db, { githubId: priya.githubId, login: 'priya-dev' }, t0 + 2 * DAY);

    expect((await listPersonClaims(db, priya.githubId)).map((c) => c.id)).toEqual(['c_2', 'c_1']);
  });
});

describe("a project's working claims", () => {
  test('the claims holding a slot count, and a claim past its deadline does not, though the table still has it working', async () => {
    const working = claim({ id: 'c_1', claimedAt: t0 + DAY });
    const paused = claim({ id: 'c_2', issue: `${repo}#19`, claimedAt: t0 + DAY - HOUR });
    const submitted = after(claim({ id: 'c_3', issue: `${repo}#20`, claimedAt: t0 + DAY }), { kind: 'submit' }, t0 + DAY + MINUTE);
    const released = after(claim({ id: 'c_4', issue: `${repo}#21`, claimedAt: t0 + DAY }), { kind: 'release', reason: 'stuck' }, t0 + DAY + MINUTE);
    // Made 25 hours before the count with no submit, so it expired, though no timer saved that yet.
    const lapsed = claim({ id: 'c_5', issue: `${repo}#22`, claimedAt: t0 });
    const elsewhere = claim({ id: 'c_6', issue: 'sample-owner/sample-tools#3', project: 'sample-owner/sample-tools', claimedAt: t0 + DAY });
    for (const made of [working, paused, submitted, released, lapsed, elsewhere]) await saveClaim(db, made, 1);

    expect(await countWorkingClaims(db, repo, t0 + DAY + HOUR)).toBe(3);
    expect(await countWorkingClaims(db, 'SAMPLE-OWNER/sample-tools', t0 + DAY + HOUR)).toBe(1);
  });
});
