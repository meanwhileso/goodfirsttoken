import type { GitHubFake } from '@goodfirsttoken/github-fake';
import type { ClaimRecord, PrRef } from '@goodfirsttoken/core';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { addPr, getPr, listClaimFollowUps } from '../../src/db';
import { issueRoom } from '../../src/rooms/issue-room';
import { CHECK_READS_PER_HOUR, prChecker, type PrChecker } from '../../src/sync/pr-checker';
import { startGitHub } from '../auth/helpers';
import { db, emptyDatabase, kenji, maintainer, priya, registeredProject, sha, signIn, t0 } from '../db/helpers';
import { freshNumbers, knowServiceToken, madeBefore, SERVICE_LOGIN } from './helpers';

// The one checker of PRs for the whole site, which reads a claim's PR when
// a donor's agent asks with check_pr, against the GitHub fake, with the
// issue rooms and D1 as they run deployed. It holds the global limits:
// checks that come in together share a read, a PR just read isn't read
// again, the hour's reads are capped, and half the service token's budget
// is left for the scheduled jobs. Every project and issue here is made up.

const APP = 'sample-owner/sample-app';
const BY = 'sample-maintainer';

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(maintainer, priya, kenji);
  await registeredProject();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  github = startGitHub();
  knowServiceToken(github);
  freshNumbers(github, APP);
  madeBefore(github, t0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const checker = () => prChecker(env.PR_CHECKER);
const ref = (n: number) => `${APP}#${String(n)}`;
const room = (n: number) => issueRoom(env.ISSUE_ROOM, ref(n));

/** priya claims a new tagged issue, submits, and opens her PR, which the room and the prs table record. */
async function claimWithPr(): Promise<{ issue: number; claim: ClaimRecord; pr: PrRef }> {
  const issue = github.openIssue(APP, { title: 'Keep the hash in rewrites', labels: ['help wanted'], by: BY });
  const number = github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });
  const pr = { repo: APP, number, url: `${github.webUrl}/${APP}/pull/${String(number)}` };
  const claimed = await room(issue).claim({
    issue: ref(issue),
    project: APP,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    slots: 3,
  });
  if (!claimed.ok) throw new Error(claimed.refusal.message);
  const submitted = await room(issue).submit({ claimId: claimed.claim.id, githubId: priya.githubId });
  if (!submitted.ok) throw new Error(submitted.refusal.message);
  const opened = await room(issue).openPr({ claimId: claimed.claim.id, githubId: priya.githubId, pr });
  if (!opened.ok) throw new Error(opened.refusal.message);
  await addPr(db, { claimId: claimed.claim.id, pr, openedAt: Date.now() });
  return { issue, claim: opened.claim, pr };
}

/** The GraphQL queries the fake answered, each with who made it. */
const queries = () => github.calls.filter((call) => call.operation.startsWith('query')).map((call) => call.login);

/** Runs `change` on the checker's own storage, as the object itself would. */
function inChecker(change: (sql: SqlStorage) => void): Promise<void> {
  return runInDurableObject(checker(), (_instance: PrChecker, state) => {
    change(state.storage.sql);
  });
}

describe('the checker of PRs', () => {
  test("a check reads the PR with the service token and records its merge, which the room announces", async () => {
    const { issue, claim, pr } = await claimWithPr();
    github.mergePullRequest(APP, pr.number, BY);

    const outcome = await checker().check(claim.id);

    expect(outcome).toBe('now');
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'merged' });
    expect((await room(issue).history()).at(-1)).toMatchObject({ kind: 'pr_merged' });
    expect(github.calls.map((call) => [call.operation, call.login])).toEqual([
      ['GET /rate_limit', SERVICE_LOGIN],
      ['query repository', SERVICE_LOGIN],
    ]);
  });

  test("a check keeps what a maintainer wrote on an open PR as a follow-up, and leaves the PR open", async () => {
    const { claim, pr } = await claimWithPr();
    github.reviewPullRequest(APP, pr.number, { login: BY, state: 'CHANGES_REQUESTED', body: 'Add a test.' });

    expect(await checker().check(claim.id)).toBe('now');

    expect(await getPr(db, claim.id)).toMatchObject({ state: 'open' });
    expect((await listClaimFollowUps(db, claim.id)).map((f) => f.body)).toEqual(['Add a test.']);
  });

  test('checks that come in while a read runs go together into the next read, one query for all of them', async () => {
    const first = await claimWithPr();
    const second = await claimWithPr();
    const third = await claimWithPr();
    for (const { pr } of [first, second, third]) github.mergePullRequest(APP, pr.number, BY);

    const outcomes = await Promise.all([first, second, third].map(({ claim }) => checker().check(claim.id)));

    expect(outcomes).toEqual(['now', 'now', 'now']);
    // The first check starts a read at once, unless one started in the last
    // 2 seconds. Those that wait share the next read, so three checks never
    // take three queries.
    expect(queries().length).toBeLessThan(3);
    expect(queries().every((login) => login === SERVICE_LOGIN)).toBe(true);
    for (const { claim } of [first, second, third]) expect(await getPr(db, claim.id)).toMatchObject({ state: 'merged' });
  });

  test('a PR read in the last 30 seconds is not read again', async () => {
    const { claim, pr } = await claimWithPr();
    expect(await checker().check(claim.id)).toBe('now');
    github.mergePullRequest(APP, pr.number, BY);

    expect(await checker().check(claim.id)).toBe('recently');

    expect(queries()).toHaveLength(1);
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'open' });
  });

  test("once the hour's reads are spent, a check reads nothing and is left for the PR job", async () => {
    const { claim, pr } = await claimWithPr();
    github.mergePullRequest(APP, pr.number, BY);
    const now = Date.now();
    await inChecker((sql) => {
      for (let i = 0; i < CHECK_READS_PER_HOUR; i++) sql.exec('INSERT INTO reads (at) VALUES (?)', now - i);
    });
    try {
      expect(await checker().check(claim.id)).toBe('later');

      expect(github.calls).toEqual([]);
      expect(await getPr(db, claim.id)).toMatchObject({ state: 'open' });
    } finally {
      await inChecker((sql) => sql.exec('DELETE FROM reads'));
    }
  });

  test("reads an hour old no longer count against the hour's cap", async () => {
    const { claim, pr } = await claimWithPr();
    github.mergePullRequest(APP, pr.number, BY);
    const hourAgo = Date.now() - 60 * 60 * 1000;
    await inChecker((sql) => {
      for (let i = 0; i < CHECK_READS_PER_HOUR; i++) sql.exec('INSERT INTO reads (at) VALUES (?)', hourAgo - i);
    });
    try {
      expect(await checker().check(claim.id)).toBe('now');
      expect(await getPr(db, claim.id)).toMatchObject({ state: 'merged' });
    } finally {
      await inChecker((sql) => sql.exec('DELETE FROM reads'));
    }
  });

  test("with less than half the token's GraphQL budget left, a check reads nothing, so the scheduled jobs keep theirs", async () => {
    const { claim, pr } = await claimWithPr();
    github.mergePullRequest(APP, pr.number, BY);
    github.spendRateLimit(SERVICE_LOGIN, 'graphql', 2501);

    expect(await checker().check(claim.id)).toBe('later');

    expect(github.calls.map((call) => call.operation)).toEqual(['GET /rate_limit']);
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'open' });
  });
});
