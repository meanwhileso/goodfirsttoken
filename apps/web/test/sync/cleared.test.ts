import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { defaultDisclosure, type ClaimRecord } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { blockDonor, getPr, saveSubmission } from '../../src/db';
import { issueRoom } from '../../src/rooms/issue-room';
import { recordClearedPrs } from '../../src/sync/cleared';
import { ALLOWANCES } from '../../src/sync/scheduled';
import { startGitHub } from '../auth/helpers';
import { db, emptyDatabase, kenji, maintainer, priya, registeredProject, signIn, t0 } from '../db/helpers';
import { callsTo, freshNumbers, jobDeps, madeBefore, SERVICE_LOGIN } from './helpers';

// The job that records cleared PRs nobody recorded, against the GitHub fake,
// with the issue rooms and D1 as they run deployed. priya's agent pushed her
// claim's branch to her fork and open_pr cleared it. She opens the PR on
// GitHub herself. Every project and issue here is made up.

const APP = 'sample-owner/sample-app';
const FORK = 'priya/sample-app';
const BY = 'sample-maintainer';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
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
  madeBefore(github, t0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function later(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

const room = (issue: string) => issueRoom(env.ISSUE_ROOM, issue);

interface Cleared {
  issue: string;
  number: number;
  claim: ClaimRecord;
  branch: string;
  head: string;
  body: string;
}

/**
 * priya claims a new tagged issue, pushes the claim's branch to her fork,
 * submits, and open_pr clears it, the way the MCP tools do.
 */
async function cleared(): Promise<Cleared> {
  const number = github.openIssue(APP, { title: 'Keep the hash in rewrites', labels: ['help wanted'], by: BY });
  const issue = `${APP}#${String(number)}`;
  const start = github.state.repos[APP]?.branches.main ?? '';
  const claimed = await room(issue).claim({
    issue,
    project: APP,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: start,
    slots: 3,
  });
  if (!claimed.ok) throw new Error(claimed.refusal.message);
  const submitted = await room(issue).submit({ claimId: claimed.claim.id, githubId: priya.githubId });
  if (!submitted.ok) throw new Error(submitted.refusal.message);
  const branch = `goodfirsttoken/issue-${String(number)}-${claimed.claim.id}`;
  const fork = github.state.repos[FORK];
  if (!fork) throw new Error('no fork');
  fork.branches[branch] = start;
  const head = github.commitFiles(FORK, { 'src/hash.ts': 'export const keepHash = true;\n' }, 'priya', {
    branch,
    message: 'Keep the hash\n\nAssisted-by: claude-code (claude-opus-5-5)',
  });
  const body = `Keeps the hash.\n\nCloses #${String(number)}\n\n${defaultDisclosure.prBody ?? ''}`;
  await saveSubmission(db, {
    claimId: claimed.claim.id,
    source: 'branch',
    repo: FORK,
    branch,
    commit: head,
    base: start,
    diffFrom: start,
    paths: ['src/hash.ts'],
    title: 'Keep the hash in rewrites',
    summary: 'Keeps the hash.',
    checks: 'pnpm test',
    agent: 'claude-code',
    model: 'claude-opus-5-5',
    additions: 1,
    deletions: 0,
    reviewReason: 'ready_to_open',
    submittedAt: Date.now(),
    clearance: { commit: head, body, at: Date.now() },
  });
  return { issue, number, claim: submitted.claim, branch, head, body };
}

/** Opens a PR as `login` on GitHub, as a person does on its form. */
async function openPr(login: string, pull: { head: string; body: string; base?: string }): Promise<number> {
  const response = await github.fetch(`${github.apiUrl}/repos/${APP}/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${github.tokenFor(login)}`, 'user-agent': 'goodfirsttoken-tests', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Keep the hash in rewrites', base: 'main', ...pull }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${String(response.status)}`);
  const answer: { number: number } = await response.json();
  return answer.number;
}

function runJob() {
  return recordClearedPrs({ ...jobDeps(github, ALLOWANCES.cleared) });
}

const prOf = (number: number) => ({ repo: APP, number, url: `${github.webUrl}/${APP}/pull/${String(number)}` });

describe('the job that records cleared PRs', () => {
  test('it records a PR the donor opened on GitHub from the cleared branch, once, with the service token', async () => {
    const { claim, branch, body } = await cleared();
    const number = await openPr('priya', { head: `priya:${branch}`, body });

    const before = github.calls.length;
    const first = await runJob();
    const reads = github.calls.slice(before);
    const second = await runJob();

    expect(first).toMatchObject({ checked: 1, recorded: 1 });
    expect(second).toMatchObject({ checked: 0, recorded: 0 });
    expect(await getPr(db, claim.id)).toMatchObject({ pr: prOf(number), state: 'open' });
    expect((await room(claim.issue).snapshot()).claims[0]).toMatchObject({ state: 'pr_opened', pr: prOf(number) });
    expect((await room(claim.issue).history()).filter((e) => e.kind === 'pr_opened')).toHaveLength(1);
    expect(reads.map((c) => c.operation)).toEqual(['GET /rate_limit', 'GET /repos/{owner}/{repo}/pulls']);
    expect(reads.every((c) => c.login === SERVICE_LOGIN)).toBe(true);
  });

  test('it records a PR merged before it ran', async () => {
    const { claim, branch, body } = await cleared();
    const number = await openPr('priya', { head: `priya:${branch}`, body });
    github.mergePullRequest(APP, number, BY);

    await runJob();

    expect((await room(claim.issue).snapshot()).claims[0]).toMatchObject({ state: 'pr_opened', pr: prOf(number) });
  });

  test('it records a PR made just before the claim expired, on a run after', async () => {
    const { claim, branch, body } = await cleared();
    later(7 * DAY - MINUTE);
    const number = await openPr('priya', { head: `priya:${branch}`, body });
    later(30 * MINUTE);

    const run = await runJob();

    expect(run.recorded).toBe(1);
    expect((await room(claim.issue).snapshot()).claims[0]).toMatchObject({ state: 'pr_opened', pr: prOf(number) });
  });

  test('it leaves alone a PR from another author or another commit, and stops looking a day after the claim expired', async () => {
    const { claim, branch, body } = await cleared();
    // kenji opens one from priya's branch at the cleared commit, with the right body.
    await openPr('kenji', { head: `priya:${branch}`, body });

    const run = await runJob();
    later(8 * DAY + MINUTE);
    const after = await runJob();

    expect(run).toMatchObject({ checked: 1, recorded: 0 });
    expect(after).toMatchObject({ checked: 0, recorded: 0 });
    expect(await getPr(db, claim.id)).toBeNull();
  });

  test('it leaves alone a PR from another branch, or from the claim branch after a push moved it', async () => {
    const { claim, branch, head, body } = await cleared();
    const fork = github.state.repos[FORK];
    if (!fork) throw new Error('no fork');
    fork.branches['keep-hash'] = head;
    await openPr('priya', { head: 'priya:keep-hash', body });
    github.commitFiles(FORK, { 'b.txt': 'b\n' }, 'priya', { branch, message: 'More\n\nAssisted-by: claude-code (claude-opus-5-5)' });
    await openPr('priya', { head: `priya:${branch}`, body });

    const run = await runJob();

    expect(run).toMatchObject({ checked: 1, recorded: 0 });
    expect(await getPr(db, claim.id)).toBeNull();
  });

  test("a claim GitHub can't list PRs for doesn't stop the run, and the claims after it are read", async () => {
    const gone = await cleared();
    const fine = await cleared();
    const number = await openPr('priya', { head: `priya:${fine.branch}`, body: fine.body });
    // gone's project is a repo GitHub no longer shows.
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/gone');
    await db.prepare('UPDATE claims SET project = ? WHERE id = ?').bind('sample-owner/gone', gone.claim.id).run();

    const run = await runJob();

    expect(run).toMatchObject({ checked: 1, recorded: 1, failed: 1, stopped: null });
    expect(await getPr(db, fine.claim.id)).toMatchObject({ pr: prOf(number) });
  });

  test("a blocked donor's PR isn't recorded", async () => {
    const { claim, branch, body } = await cleared();
    await openPr('priya', { head: `priya:${branch}`, body });
    await blockDonor(db, { githubId: priya.githubId, reason: 'Spam PRs.', blockedBy: maintainer.githubId }, Date.now());

    const run = await runJob();

    expect(run.recorded).toBe(0);
    expect(await getPr(db, claim.id)).toBeNull();
  });

  test('two cleared claims cost two list reads, and the next run reads the one read longest ago first', async () => {
    const first = await cleared();
    // A minute apart, so the older clearance comes first.
    later(MINUTE);
    const second = await cleared();

    const before = github.calls.length;
    await runJob();
    const lists = github.calls.slice(before).filter((c) => c.operation === 'GET /repos/{owner}/{repo}/pulls');

    expect(lists).toHaveLength(2);
    expect(lists.map((c) => decodeURIComponent(c.url))).toEqual([
      expect.stringContaining(first.branch) as unknown,
      expect.stringContaining(second.branch) as unknown,
    ]);
    // A run with room for one read reads the claim read longest ago: they tie, so the oldest clearance.
    later(MINUTE);
    const third = await cleared();
    const one = recordClearedPrs({ ...jobDeps(github, { leave: 0, maxCalls: 2 }) });
    const at = github.calls.length;
    await one;
    const read = github.calls.slice(at).filter((c) => c.operation === 'GET /repos/{owner}/{repo}/pulls');
    expect(read.map((c) => decodeURIComponent(c.url))).toEqual([expect.stringContaining(third.branch) as unknown]);
  });

  test('a PR the room recorded and the PRs table missed is added there, with no read of GitHub', async () => {
    const { claim, branch, body } = await cleared();
    const number = await openPr('priya', { head: `priya:${branch}`, body });
    await runJob();
    await db.prepare('DELETE FROM prs WHERE claim_id = ?').bind(claim.id).run();

    const before = github.calls.length;
    await runJob();

    expect(await getPr(db, claim.id)).toMatchObject({ pr: prOf(number), state: 'open' });
    expect(github.calls.slice(before).filter((c) => c.operation === 'GET /repos/{owner}/{repo}/pulls')).toEqual([]);
  });

  test('it reads nothing when no claim waits cleared', async () => {
    const before = github.calls.length;

    const run = await runJob();

    expect(run).toMatchObject({ checked: 0, recorded: 0, calls: 0 });
    expect(github.calls.length).toBe(before);
    expect(callsTo(github, 'GET /repos/{owner}/{repo}/pulls')).toEqual([]);
  });
});
