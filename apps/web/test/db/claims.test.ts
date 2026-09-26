import { newClaim, nextClaimState, type ClaimEvent, type ClaimRecord } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import { getClaim, listIssueClaims, listPersonClaims, savePerson, saveClaim } from '../../src/db';
import { db, DAY, emptyDatabase, HOUR, kenji, priya, refusal, repo, sha, signIn, t0 } from './helpers';

const issue = `${repo}#18`;
const pr = { repo, number: 57, url: `https://github.com/${repo}/pull/57` };

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

    await saveClaim(db, made);

    expect(await getClaim(db, 'c_1')).toEqual(made);
    expect(await getClaim(db, 'c_2')).toBeNull();
  });

  test('saving a claim again updates its timeline, its PR, and its token estimate', async () => {
    const made = claim();
    await saveClaim(db, made);
    const submitted = { ...after(made, { kind: 'submit' }, t0 + HOUR), tokenEstimate: 180_000 };
    await saveClaim(db, submitted);
    const opened = after(submitted, { kind: 'open_pr', pr }, t0 + 2 * HOUR);

    await saveClaim(db, opened);

    expect(await getClaim(db, 'c_1')).toEqual(opened);
    expect(opened).toMatchObject({ state: 'pr_opened', submittedAt: t0 + HOUR, pr, tokenEstimate: 180_000 });
  });

  test('a released claim keeps its public reason', async () => {
    const released = after(claim(), { kind: 'release', reason: 'stuck on the lock screen tests' }, t0 + HOUR);

    await saveClaim(db, released);

    expect(await getClaim(db, 'c_1')).toMatchObject({ state: 'released', releaseReason: 'stuck on the lock screen tests' });
  });

  test("a stored claim's issue and claimant never change", async () => {
    await saveClaim(db, claim());

    await refusal(saveClaim(db, claim({ issue: `${repo}#19` })));
    await refusal(saveClaim(db, claim({ githubId: kenji.githubId, login: kenji.login })));

    expect(await getClaim(db, 'c_1')).toEqual(claim());
  });

  test('a claim that breaks the claim rules is refused before it reaches the database, naming the field', async () => {
    const message = await refusal(saveClaim(db, claim({ state: 'pr_opened', submittedAt: t0 + HOUR })));

    expect(message).toContain('pr: is required for a claim with an open PR');
    expect(await getClaim(db, 'c_1')).toBeNull();
  });

  test('a claim is made by someone who has signed in', async () => {
    await refusal(saveClaim(db, claim({ githubId: 4040, login: 'nobody-yet' })));

    expect(await getClaim(db, 'c_1')).toBeNull();
  });

  test('the claims on an issue come back in the order they were made', async () => {
    await saveClaim(db, claim({ id: 'c_2', githubId: kenji.githubId, login: kenji.login, claimedAt: t0 + HOUR }));
    await saveClaim(db, claim({ id: 'c_1' }));
    await saveClaim(db, claim({ id: 'c_3', issue: `${repo}#19` }));

    expect((await listIssueClaims(db, issue)).map((c) => c.id)).toEqual(['c_1', 'c_2']);
    expect((await listIssueClaims(db, `${repo}#20`))).toEqual([]);
  });

  test("a person's claims come back newest first, and stay theirs when their login changes", async () => {
    await saveClaim(db, claim({ id: 'c_1' }));
    await saveClaim(db, claim({ id: 'c_2', issue: `${repo}#19`, claimedAt: t0 + DAY }));
    await saveClaim(db, claim({ id: 'c_3', githubId: kenji.githubId, login: kenji.login }));
    await savePerson(db, { githubId: priya.githubId, login: 'priya-dev' }, t0 + 2 * DAY);

    expect((await listPersonClaims(db, priya.githubId)).map((c) => c.id)).toEqual(['c_2', 'c_1']);
  });
});
