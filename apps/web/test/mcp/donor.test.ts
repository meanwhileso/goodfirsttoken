import type { ProjectSettingsInput, PrRef, ProjectStatus, TaggedIssue } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addPr,
  addToDoNotList,
  blockDonor,
  changeSettings,
  createProject,
  createSession,
  getClaConfirmation,
  getClaim,
  getSession,
  listProjectsAskingForHelp,
  savePerson,
  saveIssues,
  setPrState,
  setProjectLanguage,
  setProjectStatus,
} from '../../src/db';
import { issueRoom } from '../../src/rooms/issue-room';
import { APP as OAUTH_APP, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { freshNumbers } from '../sync/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// The donor's tools, called by agents through the MCP client SDK against
// the whole Worker, the issue rooms, and the GitHub fake. The people and
// repos are the fake's sample data: sample-maintainer is an admin of the
// sample-owner repos, and the donors have no role on them. sample-desktop's
// vouch file vouches for kenji and lena, names priya on another platform
// only, and denounces arjun. Every project setting and issue here is made
// up.

const APP = 'sample-owner/sample-app';
const DESKTOP = 'sample-owner/sample-desktop';
const TOOLS = 'sample-owner/sample-tools';
const BUNDLER = 'sample-owner/sample-bundler';
const HARBOR = 'sample-owner/sample-harbor';
const BY = 'sample-maintainer';
const maintainer = { githubId: 1009, login: 'sample-maintainer' };
const admin = { githubId: 9001, login: 'sample-admin' };
const people = {
  priya: { githubId: 1001, login: 'priya' },
  kenji: { githubId: 1002, login: 'kenji' },
  sam: { githubId: 1003, login: 'sam' },
  ines: { githubId: 1004, login: 'ines' },
  arjun: { githubId: 1005, login: 'arjun' },
  lena: { githubId: 1006, login: 'lena' },
};
type Login = keyof typeof people;
const MINUTE = 60_000;
const sha = '4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  // Issue rooms keep their storage across the tests in a file, so each
  // test's issues get numbers no earlier test used.
  for (const repo of [APP, DESKTOP, TOOLS, BUNDLER, HARBOR]) freshNumbers(github, repo);
  // Every call gets through the limit of 120 a minute, which tools.test.ts tests.
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  await savePerson(env.DB, maintainer, Date.now());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(agent: ConnectedAgent, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await agent.client.callTool({ name, arguments: args })) as Result;
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text).join('\n');
}

/** The refusal code a result leads with, or null when it isn't one. */
function refusalOf(result: Result): string | null {
  return result.isError ? (/^Refused \((\w+)\)/.exec(textOf(result))?.[1] ?? 'error') : null;
}

/** An agent signed in as `login`, with a session whose budget is until the limit unless one is given. */
async function donor(login: Login, budget: Record<string, unknown> = { kind: 'until_limit' }) {
  const agent = await connectAgent(github, login);
  const started = await call(agent, 'start_session', { agent: 'claude-code', budget });
  const sessionId = String(started.structuredContent?.sessionId);
  return { agent, sessionId, started };
}

/** A project added by sample-maintainer, approved unless another status is given. */
async function project(repo: string, settings: ProjectSettingsInput = { tags: ['help wanted'] }, status: ProjectStatus = 'approved') {
  await createProject(
    env.DB,
    { repo, status: status === 'pending' ? 'pending' : 'approved', source: 'registered', policy: null, settings, addedBy: maintainer.githubId },
    Date.now(),
  );
  if (status === 'paused') {
    await setProjectStatus(env.DB, repo, { status: 'paused', reason: 'Taking a break.', changedBy: maintainer.githubId }, Date.now());
  }
}

/**
 * Opens an issue on GitHub as sample-maintainer, and caches it for the
 * project as a sync would. `cache` changes what the cache says.
 */
async function tagged(
  repo: string,
  labels: string[] = ['help wanted'],
  { title = 'Fix a sample bug', body = 'The sample breaks. Fix it.', cache = {} }: { title?: string; body?: string; cache?: Partial<TaggedIssue> } = {},
): Promise<string> {
  const number = github.openIssue(repo, { title, body, labels, by: BY });
  const issue = `${repo}#${String(number)}`;
  await saveIssues(env.DB, [{ issue, project: repo, title, labels, linkedPr: null, syncedAt: Date.now(), ...cache }]);
  return issue;
}

const numberOf = (issue: string) => Number(issue.slice(issue.indexOf('#') + 1));

/** The fake's record of an issue, to change it the way people change GitHub. */
function onGitHub(issue: string) {
  const record = github.state.repos[issue.slice(0, issue.indexOf('#'))]?.issues[String(numberOf(issue))];
  if (!record) throw new Error(`the fake has no issue ${issue}`);
  return record;
}

/** The head of the repo's default branch on the fake. */
function headOf(repo: string): string {
  const record = github.state.repos[repo];
  if (!record) throw new Error(`the fake has no repo ${repo}`);
  return record.branches[record.defaultBranch] ?? '';
}

/** Someone else claims the issue through its room, as their own agent would. */
async function claimAs(login: Login, issue: string, repo: string, agent = 'codex', slots = 3) {
  await savePerson(env.DB, people[login], Date.now());
  const result = await issueRoom(env.ISSUE_ROOM, issue).claim({
    issue,
    project: repo,
    githubId: people[login].githubId,
    login,
    agent,
    ownProject: false,
    startCommit: sha,
    slots,
  });
  if (!result.ok) throw new Error(result.refusal.message);
  return result.claim;
}

async function releaseAs(login: Login, issue: string, claimId: string) {
  const result = await issueRoom(env.ISSUE_ROOM, issue).release({ claimId, githubId: people[login].githubId, reason: 'Out of time.' });
  if (!result.ok) throw new Error(result.refusal.message);
}

/** Someone's claim on the issue, submitted, with its PR open, as #16's tools will leave it. */
async function claimWithOpenPr(login: Login, issue: string, repo: string): Promise<{ claimId: string; pr: PrRef }> {
  const claim = await claimAs(login, issue, repo);
  const room = issueRoom(env.ISSUE_ROOM, issue);
  const githubId = people[login].githubId;
  const number = github.openPullRequest(repo, { title: 'Sample work', body: 'Sample work.', by: login });
  const pr = { repo, number, url: `${github.webUrl}/${repo}/pull/${String(number)}` };
  const submitted = await room.submit({ claimId: claim.id, githubId });
  if (!submitted.ok) throw new Error(submitted.refusal.message);
  const opened = await room.openPr({ claimId: claim.id, githubId, pr });
  if (!opened.ok) throw new Error(opened.refusal.message);
  await addPr(env.DB, { claimId: claim.id, pr, openedAt: Date.now() });
  return { claimId: claim.id, pr };
}

function suggested(result: Result): string[] {
  return ((result.structuredContent?.suggestions ?? []) as { issue: string }[]).map((s) => s.issue);
}

/** How many issues the homepage counts waiting for an agent. */
async function waitingOnHomepage(): Promise<number> {
  const { projects } = await listProjectsAskingForHelp(env.DB, 100, Date.now());
  return projects.reduce((sum, p) => sum + p.waiting, 0);
}

/** The GitHub token the fake gave `login`'s agent when it signed in. */
function gitHubTokenOf(login: string): string {
  const found = Object.entries(github.state.tokens).find(
    ([, grant]) => grant.clientId === OAUTH_APP.clientId && grant.login === login,
  );
  if (!found) throw new Error(`${login} has no agent token`);
  return found[0];
}

describe('start_session and set_interests', () => {
  test('the first session asks for interests, set_interests saves them, and the next session gives them back with its own budget', async () => {
    const { agent, started } = await donor('priya', { kind: 'issues', count: 3 });

    const saved = await call(agent, 'set_interests', { languages: ['TypeScript'], kinds: ['docs'] });
    const next = await call(agent, 'start_session', { agent: 'codex', budget: { kind: 'time', minutes: 90 } });

    expect(started.structuredContent).toMatchObject({ login: 'priya', interests: null, budget: { kind: 'issues', count: 3 }, followUps: [] });
    expect(textOf(started)).toContain('No saved interests. Ask the donor');
    expect(saved.structuredContent).toEqual({ interests: { languages: ['TypeScript'], projects: [], kinds: ['docs'] } });
    expect(next.structuredContent).toMatchObject({
      interests: { languages: ['TypeScript'], kinds: ['docs'] },
      budget: { kind: 'time', minutes: 90 },
    });
    expect(next.structuredContent?.sessionId).not.toBe(started.structuredContent?.sessionId);
    expect(await getSession(env.DB, String(next.structuredContent?.sessionId))).toMatchObject({
      githubId: people.priya.githubId,
      agent: 'codex',
      issuesClaimed: 0,
      queue: [],
    });
  });

  test("a new session offers the donor's paused claims first, then the rest still working, and my_work lists the same", async () => {
    await project(APP);
    const working = await tagged(APP);
    const stale = await tagged(APP);
    const released = await tagged(APP);
    // A claim made 31 minutes ago, with no update since, is paused.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 31 * MINUTE);
    const pausedClaim = await claimAs('priya', stale, APP, 'claude-code');
    vi.useRealTimers();
    const workingClaim = await claimAs('priya', working, APP, 'claude-code');
    await releaseAs('priya', released, (await claimAs('priya', released, APP, 'claude-code')).id);

    const { agent, started } = await donor('priya');
    const work = await call(agent, 'my_work');

    const unfinished = started.structuredContent?.unfinishedClaims as { claimId: string; state: string }[];
    expect(unfinished.map((c) => [c.claimId, c.state])).toEqual([
      [pausedClaim.id, 'paused'],
      [workingClaim.id, 'active'],
    ]);
    expect(textOf(started)).toContain('Offer the follow-ups and paused claims first');
    expect(textOf(started)).toContain('Resume a claim with claim_issue and its issue.');
    expect(work.structuredContent).toMatchObject({ followUps: [], readyToOpen: [] });
    expect((work.structuredContent?.working as { claimId: string }[]).map((c) => c.claimId)).toEqual([
      pausedClaim.id,
      workingClaim.id,
    ]);
  });
});

describe('claim_issue', () => {
  test("it checks GitHub with the donor's own token, and returns the issue, the project's settings and notes, the repo, and the commit to start from", async () => {
    await project(APP, { tags: ['help wanted'], agentNotes: 'Run the sample tests before you submit.' });
    const issue = await tagged(APP, ['help wanted'], { title: 'Keep the hash in rewrites', body: 'A rewrite drops the #hash.' });
    const { agent, sessionId } = await donor('priya');
    const before = github.calls.length;

    const result = await call(agent, 'claim_issue', { sessionId, issue });

    const claimId = (result.structuredContent?.claim as { claimId: string }).claimId;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      claim: { issue, title: 'Keep the hash in rewrites', state: 'active', agent: 'claude-code' },
      resumed: false,
      slotsTaken: 1,
      slots: 3,
      body: 'A rewrite drops the #hash.',
      project: { repo: APP, settings: { agentNotes: 'Run the sample tests before you submit.' } },
      clone: { url: `${github.webUrl}/${APP}.git`, commit: headOf(APP) },
      skipped: [],
      queued: [],
      budget: { issuesLeft: null, endsAt: null },
    });
    expect(textOf(result)).toContain(`Claimed ${issue} as claim ${claimId}`);
    expect(textOf(result)).toContain('Run the sample tests before you submit.');
    expect((await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims).toMatchObject([
      { id: claimId, githubId: people.priya.githubId, startCommit: headOf(APP), ownProject: false, agent: 'claude-code' },
    ]);
    expect(await getClaim(env.DB, claimId)).toMatchObject({ issue, project: APP });
    expect(await getSession(env.DB, sessionId)).toMatchObject({ issuesClaimed: 1 });
    // Every read of GitHub ran with priya's own token, and none with the service token.
    const calls = github.calls.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.token !== gitHubTokenOf('priya'))).toEqual([]);
  });

  test("a claim by an admin or maintainer of the project's repo is marked own-project work", async () => {
    await project(APP);
    const issue = await tagged(APP);
    const { agent, sessionId } = await donor('priya');
    const own = await connectAgent(github, 'sample-maintainer');
    const ownSession = String((await call(own, 'start_session', { agent: 'codex', budget: { kind: 'until_limit' } })).structuredContent?.sessionId);

    await call(agent, 'claim_issue', { sessionId, issue });
    await call(own, 'claim_issue', { sessionId: ownSession, issue });

    expect((await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims.map((c) => [c.login, c.ownProject])).toEqual([
      ['priya', false],
      ['sample-maintainer', true],
    ]);
  });

  test('claiming an issue the donor holds resumes that claim, and takes no second slot and nothing from the budget', async () => {
    await project(APP);
    const issue = await tagged(APP);
    const { agent, sessionId } = await donor('priya', { kind: 'issues', count: 2 });

    const first = await call(agent, 'claim_issue', { sessionId, issue });
    const again = await call(agent, 'claim_issue', { sessionId, issue });

    expect(again.structuredContent).toMatchObject({ resumed: true, slotsTaken: 1, claim: first.structuredContent?.claim });
    expect(textOf(again)).toContain('Resumed claim');
    expect(await getSession(env.DB, sessionId)).toMatchObject({ issuesClaimed: 1 });
  });

  test('an issue that takes no claims by the cache or the room is refused, by the rule the homepage and the issue page use', async () => {
    await project(APP, { tags: ['help wanted'], excludedTags: ['good first issue'], claimsPerIssue: 1 });
    await project(TOOLS, { tags: ['help wanted'] }, 'paused');
    await project(BUNDLER, { tags: ['help wanted'] }, 'pending');
    await project(HARBOR);
    await savePerson(env.DB, admin, Date.now());
    await addToDoNotList(env.DB, { repo: HARBOR, reason: null, addedBy: admin.githubId }, Date.now());
    const untagged = await tagged(APP, ['bug']);
    const excluded = await tagged(APP, ['help wanted', 'good first issue']);
    const linked = await tagged(APP, ['help wanted'], {
      cache: { linkedPr: { repo: APP, number: 7, url: `${github.webUrl}/${APP}/pull/7` }, linkedPrFoundBy: ['closing_reference'] },
    });
    const withClaimPr = await tagged(APP);
    await claimWithOpenPr('kenji', withClaimPr, APP);
    const full = await tagged(APP);
    await claimAs('kenji', full, APP, 'codex', 1);
    const paused = await tagged(TOOLS);
    const pending = await tagged(BUNDLER);
    const listed = await tagged(HARBOR);
    const nowhere = `${DESKTOP}#${String(github.openIssue(DESKTOP, { title: 'Not a project', labels: ['ready'], by: BY }))}`;
    const good = await tagged(APP);
    const { agent, sessionId } = await donor('priya');

    const refusals = [];
    for (const issue of [untagged, excluded, linked, withClaimPr, full, paused, pending, listed, nowhere]) {
      refusals.push([issue, refusalOf(await call(agent, 'claim_issue', { sessionId, issue }))]);
    }
    const suggestions = await call(agent, 'suggest_issues', { sessionId });

    expect(refusals).toEqual([
      [untagged, 'issue_not_eligible'],
      [excluded, 'issue_not_eligible'],
      [linked, 'pr_exists'],
      [withClaimPr, 'pr_exists'],
      [full, 'issue_full'],
      [paused, 'project_not_open'],
      [pending, 'project_not_open'],
      [listed, 'project_not_open'],
      [nowhere, 'not_found'],
    ]);
    // suggest_issues offers the one issue that takes claims, the one the homepage counts.
    expect(suggested(suggestions)).toEqual([good]);
    expect(await waitingOnHomepage()).toBe(1);
    expect(await getSession(env.DB, sessionId)).toMatchObject({ issuesClaimed: 0 });
  });

  test('an issue that stopped taking claims on GitHub since the last sync is refused: closed, assigned, untagged, given an excluded label, or with a PR open in the project', async () => {
    await project(APP, { tags: ['help wanted'], excludedTags: ['good first issue'] });
    await project(TOOLS);
    const closed = await tagged(APP);
    github.closeIssue(APP, numberOf(closed), BY);
    const assigned = await tagged(APP);
    github.assignIssue(APP, numberOf(assigned), 'kenji', BY);
    const untagged = await tagged(APP);
    onGitHub(untagged).labels = [];
    const excluded = await tagged(APP);
    github.labelIssue(APP, numberOf(excluded), 'good first issue', BY);
    const closing = await tagged(APP);
    github.openPullRequest(APP, { title: 'A fix', body: `Closes #${String(numberOf(closing))}`, by: 'kenji' });
    const mentioned = await tagged(APP);
    github.openPullRequest(APP, { title: 'Related work', body: `Touches #${String(numberOf(mentioned))} too.`, by: 'kenji' });
    // A PR in another repo that would close the issue says nothing about work on it here.
    const elsewhere = await tagged(APP);
    github.openPullRequest(TOOLS, { title: 'Downstream fix', body: `Fixes ${elsewhere}`, by: 'kenji' });
    const { agent, sessionId } = await donor('priya');

    const refusals = [];
    for (const issue of [closed, assigned, untagged, excluded, closing, mentioned, elsewhere]) {
      refusals.push([issue, refusalOf(await call(agent, 'claim_issue', { sessionId, issue }))]);
    }

    expect(refusals).toEqual([
      [closed, 'issue_not_eligible'],
      [assigned, 'issue_not_eligible'],
      [untagged, 'issue_not_eligible'],
      [excluded, 'issue_not_eligible'],
      [closing, 'pr_exists'],
      [mentioned, 'pr_exists'],
      [elsewhere, null],
    ]);
  });

  test('an issue whose PR merged is refused, though the cache still lists it and its room holds no PR until the next sync', async () => {
    await project(APP);
    const issue = await tagged(APP);
    const pr = github.openPullRequest(APP, { title: 'The fix', body: `Closes #${String(numberOf(issue))}`, by: 'kenji' });
    github.mergePullRequest(APP, pr, BY);
    const { agent, sessionId } = await donor('priya');

    const result = await call(agent, 'claim_issue', { sessionId, issue });

    expect(refusalOf(result)).toBe('issue_not_eligible');
    expect(textOf(result)).toContain('is closed on GitHub');
    expect((await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims).toEqual([]);
  });

  test("a project that takes vouched donors only refuses a donor its vouch file doesn't list, and takes one it does", async () => {
    await project(DESKTOP, { tags: ['ready'], whoCanClaim: 'vouched' });
    const issue = await tagged(DESKTOP, ['ready']);
    const priya = await donor('priya');
    const kenji = await donor('kenji');

    const refused = await call(priya.agent, 'claim_issue', { sessionId: priya.sessionId, issue });
    const offered = await call(priya.agent, 'suggest_issues', { sessionId: priya.sessionId });
    const claimed = await call(kenji.agent, 'claim_issue', { sessionId: kenji.sessionId, issue });

    expect(refusalOf(refused)).toBe('not_vouched');
    expect(textOf(refused)).toContain(".github/VOUCHED.td, lists, and it doesn't list @priya");
    expect(suggested(offered)).toEqual([]);
    expect(claimed.isError).toBeFalsy();
  });

  test('a donor the vouch file denounces is refused and offered nothing, even where the project lets anyone claim', async () => {
    await project(DESKTOP, { tags: ['ready'], whoCanClaim: 'anyone' });
    const issue = await tagged(DESKTOP, ['ready']);
    const arjun = await donor('arjun');
    const priya = await donor('priya');

    const refused = await call(arjun.agent, 'claim_issue', { sessionId: arjun.sessionId, issue });
    const offered = await call(arjun.agent, 'suggest_issues', { sessionId: arjun.sessionId });
    const claimed = await call(priya.agent, 'claim_issue', { sessionId: priya.sessionId, issue });

    expect(refusalOf(refused)).toBe('not_vouched');
    expect(textOf(refused)).toContain('denounces @arjun');
    expect(suggested(offered)).toEqual([]);
    expect(claimed.isError).toBeFalsy();
  });

  test('a blocked donor gets no suggestions and no claims', async () => {
    await project(APP);
    const issue = await tagged(APP);
    const { agent, sessionId } = await donor('priya');
    await savePerson(env.DB, admin, Date.now());
    await blockDonor(env.DB, { githubId: people.priya.githubId, reason: 'Spam.', blockedBy: admin.githubId }, Date.now());

    const suggestions = await call(agent, 'suggest_issues', { sessionId });
    const claim = await call(agent, 'claim_issue', { sessionId, issue });

    expect(refusalOf(suggestions)).toBe('donor_blocked');
    expect(refusalOf(claim)).toBe('donor_blocked');
    expect((await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims).toEqual([]);
  });

  test("a donor with as many open PRs in the project as it allows is refused and offered none of its issues, until one merges", async () => {
    await project(APP, { tags: ['help wanted'], openPrsPerDonor: 1 });
    const done = await tagged(APP);
    const { claimId } = await claimWithOpenPr('priya', done, APP);
    const issue = await tagged(APP);
    const { agent, sessionId } = await donor('priya');

    const refused = await call(agent, 'claim_issue', { sessionId, issue });
    const offered = await call(agent, 'suggest_issues', { sessionId });
    await setPrState(env.DB, claimId, 'merged', Date.now());
    const claimed = await call(agent, 'claim_issue', { sessionId, issue });

    expect(refusalOf(refused)).toBe('open_pr_cap');
    expect(textOf(refused)).toContain(`You have 1 open PR in ${APP}, and it allows 1 per donor.`);
    expect(suggested(offered)).toEqual([]);
    expect(claimed.isError).toBeFalsy();
  });

  test("a project's CLA is confirmed once per project, and asked again when its link changes", async () => {
    await project(TOOLS, { tags: ['help wanted'], claUrl: 'https://sample-owner.test/cla' });
    const first = await tagged(TOOLS);
    const second = await tagged(TOOLS);
    const third = await tagged(TOOLS);
    const { agent, sessionId } = await donor('priya');

    const asked = await call(agent, 'claim_issue', { sessionId, issue: first });
    const confirmed = await call(agent, 'claim_issue', { sessionId, issue: first, claConfirmed: true });
    const notAskedAgain = await call(agent, 'claim_issue', { sessionId, issue: second });
    await changeSettings(env.DB, TOOLS, { claUrl: 'https://sample-owner.test/cla-v2' }, maintainer.githubId, Date.now());
    const askedAgain = await call(agent, 'claim_issue', { sessionId, issue: third });

    expect(refusalOf(asked)).toBe('cla_required');
    expect(textOf(asked)).toContain('https://sample-owner.test/cla. Ask the donor to confirm they signed it');
    expect(confirmed.isError).toBeFalsy();
    expect(notAskedAgain.isError).toBeFalsy();
    expect(refusalOf(askedAgain)).toBe('cla_required');
    expect(await getClaConfirmation(env.DB, people.priya.githubId, TOOLS)).toMatchObject({ claUrl: 'https://sample-owner.test/cla' });
  });

  test("a session is its donor's alone: another donor's session ID finds no session", async () => {
    await project(APP);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const kenji = await donor('kenji');

    const claim = await call(kenji.agent, 'claim_issue', { sessionId: priya.sessionId, issue });
    const suggestions = await call(kenji.agent, 'suggest_issues', { sessionId: priya.sessionId });

    expect(refusalOf(claim)).toBe('not_found');
    expect(refusalOf(suggestions)).toBe('not_found');
    expect((await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims).toEqual([]);
  });
});

describe('the budget', () => {
  test('a budget of issues counts each new claim, and refuses claims and suggestions once it is spent', async () => {
    await project(APP, { tags: ['help wanted'], claimsPerIssue: 1 });
    const full = await tagged(APP);
    await claimAs('kenji', full, APP, 'codex', 1);
    const first = await tagged(APP);
    const second = await tagged(APP);
    const { agent, sessionId } = await donor('priya', { kind: 'issues', count: 1 });

    const refused = await call(agent, 'claim_issue', { sessionId, issue: full });
    const claimed = await call(agent, 'claim_issue', { sessionId, issue: first });
    const spent = await call(agent, 'claim_issue', { sessionId, issue: second });
    const suggestions = await call(agent, 'suggest_issues', { sessionId });

    // A claim that was refused took nothing from the budget.
    expect(refusalOf(refused)).toBe('issue_full');
    expect(claimed.structuredContent).toMatchObject({ budget: { issuesLeft: 0 } });
    expect(textOf(claimed)).toContain('Budget left: 0 issues.');
    expect(refusalOf(spent)).toBe('budget_spent');
    expect(textOf(spent)).toContain(`Session ${sessionId} has spent its budget: 1 of 1 issues claimed.`);
    expect(refusalOf(suggestions)).toBe('budget_spent');
    expect(await getSession(env.DB, sessionId)).toMatchObject({ issuesClaimed: 1 });
  });

  test('a budget of time refuses new claims once its minutes have passed', async () => {
    await project(APP);
    const issue = await tagged(APP);
    const { agent } = await donor('priya');
    const session = await createSession(
      env.DB,
      { githubId: people.priya.githubId, agent: 'claude-code', budget: { kind: 'time', minutes: 30 } },
      Date.now() - 31 * MINUTE,
    );

    const result = await call(agent, 'claim_issue', { sessionId: session.id, issue });

    expect(refusalOf(result)).toBe('budget_spent');
    expect(textOf(result)).toContain('its 30 minutes are up');
  });
});

describe('the queue', () => {
  test('a queued pick is claimed only when the agent reaches it, and one that filled up or got a PR meanwhile is skipped and reported', async () => {
    await project(APP, { tags: ['help wanted'], claimsPerIssue: 1 });
    const [now, fills, gets, next] = [await tagged(APP), await tagged(APP), await tagged(APP), await tagged(APP)];
    const { agent, sessionId } = await donor('priya');

    const first = await call(agent, 'claim_issue', { sessionId, issue: now, queue: [fills, gets, next] });
    const untouched = await Promise.all([fills, gets, next].map(async (i) => (await issueRoom(env.ISSUE_ROOM, i).snapshot()).claims));
    // Meanwhile, kenji takes the only slot on one, and opens a PR for another.
    await claimAs('kenji', fills, APP, 'codex', 1);
    github.openPullRequest(APP, { title: 'A fix', body: `Closes #${String(numberOf(gets))}`, by: 'kenji' });
    const reached = await call(agent, 'claim_issue', { sessionId });
    const empty = await call(agent, 'claim_issue', { sessionId });

    expect(first.structuredContent).toMatchObject({ queued: [fills, gets, next], skipped: [] });
    expect(textOf(first)).toContain(`Queued next (3): ${fills}, ${gets}, ${next}.`);
    expect(untouched).toEqual([[], [], []]);
    expect(reached.structuredContent).toMatchObject({
      claim: { issue: next },
      skipped: [
        { issue: fills, code: 'issue_full' },
        { issue: gets, code: 'pr_exists' },
      ],
      queued: [],
    });
    expect(textOf(reached)).toContain(`Skipped from the queue (2):\n  1  ${fills} (issue_full)`);
    expect(refusalOf(empty)).toBe('not_found');
    expect(textOf(empty)).toContain(`No pick waits in session ${sessionId}.`);
  });

  test("a queued pick whose project asks for a CLA stops the queue there, and stays next until the donor confirms", async () => {
    await project(TOOLS, { tags: ['help wanted'], claUrl: 'https://sample-owner.test/cla' });
    const pick = await tagged(TOOLS);
    const { agent, sessionId } = await donor('priya');

    const asked = await call(agent, 'claim_issue', { sessionId, queue: [pick] });
    const kept = await getSession(env.DB, sessionId);
    const confirmed = await call(agent, 'claim_issue', { sessionId, claConfirmed: true });

    expect(refusalOf(asked)).toBe('cla_required');
    expect(kept?.queue).toEqual([pick]);
    expect(confirmed.structuredContent).toMatchObject({ claim: { issue: pick }, queued: [] });
  });

  test('a CLA confirmation counts for the pick it was asked about, and never for a pick behind it', async () => {
    await project(TOOLS, { tags: ['help wanted'], claUrl: 'https://sample-owner.test/cla', claimsPerIssue: 1 });
    await project(BUNDLER, { tags: ['help wanted'], claUrl: 'https://sample-owner.test/bundler-cla' });
    const asked = await tagged(TOOLS);
    const behind = await tagged(BUNDLER);
    const { agent, sessionId } = await donor('priya');

    await call(agent, 'claim_issue', { sessionId, queue: [asked, behind] });
    // Before the donor answers, the pick asked about fills up.
    await claimAs('kenji', asked, TOOLS, 'codex', 1);
    const confirmed = await call(agent, 'claim_issue', { sessionId, claConfirmed: true });

    expect(refusalOf(confirmed)).toBe('cla_required');
    expect(textOf(confirmed)).toContain('https://sample-owner.test/bundler-cla');
    expect(textOf(confirmed)).toContain(`Skipped from the queue first:\n${asked} (issue_full)`);
    expect(await getClaConfirmation(env.DB, people.priya.githubId, BUNDLER)).toBeNull();
    expect((await getSession(env.DB, sessionId))?.queue).toEqual([behind]);
  });
});

describe('post_update and release_claim', () => {
  test("a donor posts to and releases their own claim, and is refused on anyone else's", async () => {
    await project(APP);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const kenji = await donor('kenji');
    const claimed = await call(priya.agent, 'claim_issue', { sessionId: priya.sessionId, issue });
    const claimId = (claimed.structuredContent?.claim as { claimId: string }).claimId;

    const theirPost = await call(kenji.agent, 'post_update', { claimId, text: 'wrote a failing test' });
    const theirRelease = await call(kenji.agent, 'release_claim', { claimId, reason: 'Not mine.' });
    const post = await call(priya.agent, 'post_update', { claimId, text: 'wrote failing test: rewrites keep #hash' });
    const release = await call(priya.agent, 'release_claim', { claimId, reason: 'Out of time.' });
    const unknown = await call(priya.agent, 'post_update', { claimId: 'c_nothing', text: 'hello' });

    expect(refusalOf(theirPost)).toBe('not_claim_owner');
    expect(refusalOf(theirRelease)).toBe('not_claim_owner');
    expect(post.structuredContent).toMatchObject({ posted: true, claimId, state: 'active' });
    expect(release.structuredContent).toEqual({ claimId, issue, state: 'released' });
    expect(refusalOf(unknown)).toBe('not_found');
    const history = await issueRoom(env.ISSUE_ROOM, issue).history();
    expect(history.map((e) => [e.user, e.kind, e.text])).toEqual([
      ['priya', 'claimed', 'claimed the issue'],
      ['priya', 'update', 'wrote failing test: rewrites keep #hash'],
      ['priya', 'released', 'released: Out of time.'],
    ]);
  });
});

describe('suggest_issues', () => {
  test("suggestions check each issue on GitHub with the donor's token, and leave out one closed or given a PR since the last sync", async () => {
    await project(APP);
    const closed = await tagged(APP);
    github.closeIssue(APP, numberOf(closed), BY);
    const linked = await tagged(APP);
    github.openPullRequest(APP, { title: 'A fix', body: `Closes #${String(numberOf(linked))}`, by: 'kenji' });
    const open = await tagged(APP);
    const { agent, sessionId } = await donor('priya');
    const before = github.calls.length;

    const result = await call(agent, 'suggest_issues', { sessionId });

    expect(suggested(result)).toEqual([open]);
    expect(await waitingOnHomepage()).toBe(3);
    const calls = github.calls.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.token !== gitHubTokenOf('priya'))).toEqual([]);
  });

  test('suggestions leave out the issues already shown, the picks in the queue, and the issues the donor holds', async () => {
    await project(APP);
    const [shown, queued, held, left] = [await tagged(APP), await tagged(APP), await tagged(APP), await tagged(APP)];
    const { agent, sessionId } = await donor('priya');
    await call(agent, 'claim_issue', { sessionId, issue: held, queue: [queued] });

    const result = await call(agent, 'suggest_issues', { sessionId, exclude: [shown] });

    expect(suggested(result)).toEqual([left]);
  });

  test('each suggestion carries its claimants and their agents, how many times it was claimed, and the tough badge after 3 claims that ended without a merged PR', async () => {
    await project(APP);
    const tough = await tagged(APP, ['help wanted'], { title: 'The hard one' });
    for (const login of ['sam', 'ines', 'lena'] as const) await releaseAs(login, tough, (await claimAs(login, tough, APP)).id);
    await claimAs('kenji', tough, APP, 'codex');
    // A blocked donor's claim takes its slot, and names no one.
    await claimAs('arjun', tough, APP, 'opencode');
    await savePerson(env.DB, admin, Date.now());
    await blockDonor(env.DB, { githubId: people.arjun.githubId, reason: null, blockedBy: admin.githubId }, Date.now());
    const tried = await tagged(APP, ['help wanted'], { title: 'Tried twice' });
    for (const login of ['sam', 'ines'] as const) await releaseAs(login, tried, (await claimAs(login, tried, APP)).id);
    const { agent, sessionId } = await donor('priya');

    const result = await call(agent, 'suggest_issues', { sessionId });

    const byIssue = new Map(((result.structuredContent?.suggestions ?? []) as { issue: string }[]).map((s) => [s.issue, s]));
    expect(byIssue.get(tough)).toMatchObject({
      title: 'The hard one',
      project: APP,
      tag: 'help wanted',
      prMode: 'reviewed',
      claUrl: null,
      claimants: [{ login: 'kenji', agent: 'codex', state: 'active' }],
      slots: 3,
      timesClaimed: 5,
      tough: true,
    });
    expect(byIssue.get(tried)).toMatchObject({ claimants: [], timesClaimed: 2, tough: false });
    expect(textOf(result)).toContain('tough: claimed 5 times without a merged PR');
    expect(textOf(result)).not.toContain('arjun');
    expect(textOf(result)).toContain('1 of 3 slots taken: @kenji (codex)');
  });

  test("suggestions are ranked against the donor's interests: a project they named, then their language, then a kind of work they like", async () => {
    for (const repo of [APP, TOOLS, BUNDLER, HARBOR]) await project(repo);
    await setProjectLanguage(env.DB, APP, 'TypeScript');
    await setProjectLanguage(env.DB, HARBOR, 'Go');
    await setProjectLanguage(env.DB, BUNDLER, 'TypeScript');
    const plain = await tagged(APP);
    const docs = await tagged(TOOLS, ['help wanted', 'documentation']);
    const inGo = await tagged(HARBOR);
    const named = await tagged(BUNDLER);
    const { agent, sessionId } = await donor('priya');
    await call(agent, 'set_interests', { projects: ['sample-bundler'], languages: ['go'], kinds: ['docs'] });
    // With every draw at 0, the random order is the ranking itself.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = await call(agent, 'suggest_issues', { sessionId });

    expect(suggested(result)).toEqual([named, inGo, docs]);
    expect(suggested(result)).not.toContain(plain);
  });

  test('donors asking at the same moment are offered different issues, drawn at random with weight toward the top', async () => {
    await project(APP);
    const issues = [];
    for (let i = 0; i < 10; i++) issues.push(await tagged(APP));
    const donors = [];
    for (const login of ['priya', 'kenji', 'sam', 'ines'] as const) donors.push(await donor(login));
    // A fixed sequence of draws, so the test gives the same answer every run.
    let state = 7;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      state = (state * 48_271) % 2_147_483_647;
      return state / 2_147_483_647;
    });

    const results = await Promise.all(donors.map(({ agent, sessionId }) => call(agent, 'suggest_issues', { sessionId })));

    const offered = results.map((result) => suggested(result));
    expect(offered.every((list) => list.length === 3)).toBe(true);
    expect(new Set(offered.map((list) => [...list].sort().join(' '))).size).toBeGreaterThan(1);
    expect(new Set(offered.flat()).size).toBeGreaterThan(3);
  });
});
