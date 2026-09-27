import type { GitHubFake } from '@goodfirsttoken/github-fake';
import type { ClaimRecord, PrRef } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { addPr, getIssue, getPr } from '../../src/db';
import { issueRoom, type IssueRoom } from '../../src/rooms/issue-room';
import { syncTaggedIssues } from '../../src/sync/issues';
import { followPrs } from '../../src/sync/prs';
import { ALLOWANCES } from '../../src/sync/scheduled';
import { startGitHub } from '../auth/helpers';
import { db, emptyDatabase, kenji, maintainer, priya, registeredProject, sha, signIn } from '../db/helpers';
import { freshNumbers, jobDeps, SERVICE_LOGIN } from './helpers';

// The PR job, which follows each claim's PR on GitHub until it merges or
// closes, against the GitHub fake, with the issue rooms and D1 as they run
// deployed. priya works an issue in sample-app through its room, and her PR
// comes from her fork. Every project and issue here is made up.

const APP = 'sample-owner/sample-app';
const BY = 'sample-maintainer';
const MINUTE = 60_000;
// Far ahead of the real clock, so no alarm a room sets fires on its own.
const start = Date.UTC(2100, 4, 1, 12, 0, 0);

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(maintainer, priya, kenji);
  await registeredProject();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  github = startGitHub();
  freshNumbers(github, APP);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function later(ms = 30 * MINUTE): void {
  vi.setSystemTime(Date.now() + ms);
}

const ref = (n: number) => `${APP}#${String(n)}`;
const room = (n: number) => issueRoom(env.ISSUE_ROOM, ref(n));

function claimAs(person: { githubId: number; login: string }, n: number) {
  return room(n).claim({
    issue: ref(n),
    project: APP,
    githubId: person.githubId,
    login: person.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    slots: 3,
  });
}

/**
 * priya claims a new tagged issue, submits, and opens her PR, which closes
 * the issue, the way the MCP tools will. The room records the PR, and so
 * does the prs table.
 */
async function claimWithPr(): Promise<{ issue: number; claim: ClaimRecord; pr: PrRef }> {
  const issue = github.openIssue(APP, { title: 'Keep the hash in rewrites', labels: ['help wanted'], by: BY });
  const number = github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });
  const pr = { repo: APP, number, url: `${github.webUrl}/${APP}/pull/${String(number)}` };
  const claimed = await claimAs(priya, issue);
  if (!claimed.ok) throw new Error(claimed.refusal.message);
  const submitted = await room(issue).submit({ claimId: claimed.claim.id, githubId: priya.githubId });
  if (!submitted.ok) throw new Error(submitted.refusal.message);
  const opened = await room(issue).openPr({ claimId: claimed.claim.id, githubId: priya.githubId, pr });
  if (!opened.ok) throw new Error(opened.refusal.message);
  await addPr(db, { claimId: claimed.claim.id, pr, openedAt: Date.now() });
  return { issue, claim: opened.claim, pr };
}

function follow(deps: Partial<ReturnType<typeof jobDeps>> = {}) {
  return followPrs({ ...jobDeps(github, ALLOWANCES.prs), ...deps });
}

describe('the PR job', () => {
  test("a claim's PR that merges is recorded merged at GitHub's time, and its room forgets it", async () => {
    const { issue, claim, pr } = await claimWithPr();
    later();
    github.mergePullRequest(APP, pr.number, BY);
    const mergedAt = Date.now();
    later();

    const run = await follow();

    expect(run).toMatchObject({ checked: 1, merged: 1, closed: 0, stopped: null });
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'merged', mergedAt, closedAt: mergedAt });
    expect((await room(issue).snapshot()).prs).toEqual([]);
  });

  test("a claim's PR closed without merging is recorded closed, and its issue takes claims again", async () => {
    const { issue, claim, pr } = await claimWithPr();
    const refused = await claimAs(kenji, issue);
    github.closePullRequest(APP, pr.number, BY);
    later();

    await follow();

    expect(refused).toMatchObject({ ok: false, refusal: { code: 'pr_exists' } });
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'closed', mergedAt: null });
    expect(await claimAs(kenji, issue)).toMatchObject({ ok: true, created: true });
  });

  test('a PR still open stays open, and its room keeps it', async () => {
    const { issue, claim, pr } = await claimWithPr();

    const run = await follow();

    expect(run).toMatchObject({ checked: 1, merged: 0, closed: 0 });
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'open' });
    expect((await room(issue).snapshot()).prs).toEqual([pr]);
  });

  test("when the room doesn't hear the PR closed, the PR stays open in the table, and the next run tries again", async () => {
    const { issue, claim, pr } = await claimWithPr();
    github.closePullRequest(APP, pr.number, BY);
    const down = {
      getByName: () => ({ prClosed: () => Promise.reject(new Error('The room is down.')) }),
    } as unknown as DurableObjectNamespace<IssueRoom>;

    await follow({ rooms: down });
    const unheard = await getPr(db, claim.id);
    later();
    await follow();

    expect(unheard).toMatchObject({ state: 'open' });
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'closed' });
    expect((await room(issue).snapshot()).prs).toEqual([]);
  });

  test("the sync leaves a claim's PR that closed to the PR job, which closes it in the room", async () => {
    const { issue, claim, pr } = await claimWithPr();
    await syncTaggedIssues(jobDeps(github));
    const linked = (await getIssue(db, APP, ref(issue)))?.linkedPr;
    github.closePullRequest(APP, pr.number, BY);
    later();

    await syncTaggedIssues(jobDeps(github));
    const afterSync = (await room(issue).snapshot()).prs;
    await follow();

    expect(linked).toEqual(pr);
    expect((await getIssue(db, APP, ref(issue)))?.linkedPr).toBeNull();
    // The claim's PR is still open in the prs table until the PR job reads it.
    expect(afterSync).toEqual([pr]);
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'closed' });
    expect((await room(issue).snapshot()).prs).toEqual([]);
  });

  test('the job asks GitHub what is left of the budget, then reads every open PR in one query, with the service token', async () => {
    await claimWithPr();
    await claimWithPr();

    const run = await follow();

    expect(run.checked).toBe(2);
    expect(github.calls.map((call) => [call.operation, call.login])).toEqual([
      ['GET /rate_limit', SERVICE_LOGIN],
      ['query repository', SERVICE_LOGIN],
    ]);
  });

  test('with no open PR, the job asks GitHub nothing', async () => {
    const run = await follow();

    expect(run.checked).toBe(0);
    expect(github.calls).toEqual([]);
  });

  test('a spent GraphQL budget stops the job before it reads, and changes nothing', async () => {
    const { claim, pr } = await claimWithPr();
    github.closePullRequest(APP, pr.number, BY);
    github.spendRateLimit(SERVICE_LOGIN, 'graphql', 5000);

    const run = await follow();

    expect(run.stopped).toBe('budget');
    expect(github.calls.map((call) => call.operation)).toEqual(['GET /rate_limit']);
    expect(await getPr(db, claim.id)).toMatchObject({ state: 'open' });
  });
});
