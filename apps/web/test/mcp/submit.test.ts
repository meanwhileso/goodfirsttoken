import type { ProjectSettingsInput, ProjectStatus } from '@goodfirsttoken/core';
import type { FakeState, GitHubFake, RecordedCall } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { adminRemoveProject } from '../../src/admin/actions';
import {
  blockDonor,
  createProject,
  getClaim,
  getPr,
  getSubmission,
  saveIssues,
  savePerson,
  setPrState,
  setProjectStatus,
} from '../../src/db';
import { issueRoom } from '../../src/rooms/issue-room';
import { APP as OAUTH_APP, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { freshNumbers } from '../sync/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// submit_work and open_pr, called by agents through the MCP client SDK
// against the whole Worker, the issue rooms, and the GitHub fake, which
// keeps state, so a fork, a branch, a commit, and a PR follow each other as
// they do on GitHub. sample-maintainer is an admin of the sample-owner
// repos. The donors can push to none of them, unless a test gives them
// write access, and priya already has a fork of sample-app. Every project
// setting, issue, and file here is made up.
//
// The permission-isolation check is the afterEach below: every GitHub call
// that submit_work, open_pr, or my_work made ran with the token of the donor
// whose claim it is, from their own agent. A maintainer's token, another
// donor's, and the service token never do a donor's work.

const APP = 'sample-owner/sample-app';
const TOOLS = 'sample-owner/sample-tools';
const BY = 'sample-maintainer';
const maintainer = { githubId: 1009, login: 'sample-maintainer' };
const admin = { githubId: 9001, login: 'sample-admin' };
const people = {
  priya: { githubId: 1001, login: 'priya' },
  kenji: { githubId: 1002, login: 'kenji' },
  sam: { githubId: 1003, login: 'sam' },
  lena: { githubId: 1006, login: 'lena' },
  'sample-maintainer': maintainer,
};
type Login = keyof typeof people;
const HOUR = 60 * 60_000;
const DISCLOSURE = 'Written with a coding agent through Good First Token.';
const NOTES = {
  summary: 'Keeps the trailing slash when a rewrite runs.',
  checks: 'pnpm test: 12 passing.',
  agent: 'claude-code',
  model: 'claude-opus-5-5',
};
const README = '# sample-app\n\nA sample app for tests and local development.\n';

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  // Most tests fork at once. The ones about a fork GitHub is still making
  // set a delay of their own.
  github.forkDelayMs = 0;
  // Issue rooms keep their storage across the tests in a file, so each
  // test's issues get numbers no earlier test used.
  for (const repo of [APP, TOOLS]) freshNumbers(github, repo);
  // Every call gets through the limit of 120 a minute, which tools.test.ts tests.
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  await savePerson(env.DB, maintainer, Date.now());
});

/** A tool call on the submit and PR paths, with who made it, whose claim it was for, and the GitHub calls it made. */
interface PathCall {
  tool: string;
  caller: string;
  /** The claimant's login, or null for a claim the table doesn't have. my_work is for the caller. */
  owner: string | null;
  calls: RecordedCall[];
}

const PATHS = new Set(['submit_work', 'open_pr', 'my_work']);
let pathCalls: PathCall[] = [];

afterEach(({ task }) => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Every call the Worker made to GitHub's API ran with a token the site's
  // OAuth app gave an agent when its person signed in.
  const calls = github.calls.filter((c) => c.url.startsWith(github.apiUrl));
  const notAnAgent = calls.filter((c) => c.token === null || github.state.tokens[c.token]?.clientId !== OAUTH_APP.clientId);
  expect(notAnAgent.map((c) => `${c.operation} as ${c.login ?? 'no one'}`), task.name).toEqual([]);
  // Each call on the submit and PR paths ran as the donor whose claim it is,
  // who is also the one who called.
  const crossed = pathCalls.flatMap(({ tool, caller, owner, calls: made }) =>
    made
      .filter((c) => c.login === null || c.login !== owner || c.login !== caller)
      .map((c) => `${tool} by @${caller} for @${owner ?? 'no one'}'s claim: ${c.operation} as @${c.login ?? 'no one'}`),
  );
  expect(crossed, task.name).toEqual([]);
  pathCalls = [];
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Donor {
  agent: ConnectedAgent;
  login: Login;
  sessionId: string;
}

/** Calls a tool as the donor. A call on the submit and PR paths is kept for the isolation check. */
async function call(donor: Donor, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const claimId = typeof args.claimId === 'string' ? args.claimId : null;
  const owner = claimId === null ? donor.login : ((await getClaim(env.DB, claimId))?.login ?? null);
  const before = github.calls.length;
  const result = (await donor.agent.client.callTool({ name, arguments: args })) as Result;
  if (PATHS.has(name)) {
    pathCalls.push({
      tool: name,
      caller: donor.login,
      owner,
      calls: github.calls.slice(before).filter((c) => c.url.startsWith(github.apiUrl)),
    });
  }
  return result;
}

/** The GitHub calls the last call on the submit and PR paths made. */
function lastCalls(): RecordedCall[] {
  return pathCalls.at(-1)?.calls ?? [];
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text).join('\n');
}

/** The refusal code a result leads with, or null when it isn't one. */
function refusalOf(result: Result): string | null {
  return result.isError ? (/^Refused \((\w+)\)/.exec(textOf(result))?.[1] ?? 'error') : null;
}

/** An agent signed in as `login`, with a session. */
async function donor(login: Login): Promise<Donor> {
  const agent = await connectAgent(github, login);
  const started = (await agent.client.callTool({
    name: 'start_session',
    arguments: { agent: 'claude-code', budget: { kind: 'until_limit' } },
  })) as Result;
  return { agent, login, sessionId: String(started.structuredContent?.sessionId) };
}

/** A project added by sample-maintainer, approved unless another status is given. */
async function project(repo: string, settings: ProjectSettingsInput, status: ProjectStatus = 'approved') {
  await createProject(
    env.DB,
    { repo, status: 'approved', source: 'registered', policy: null, settings, addedBy: maintainer.githubId },
    Date.now(),
  );
  if (status === 'paused') {
    await setProjectStatus(env.DB, repo, { status: 'paused', reason: 'Taking a break.', changedBy: maintainer.githubId }, Date.now());
  }
}

const automatic: ProjectSettingsInput = { tags: ['help wanted'], prMode: 'automatic' };
const reviewed: ProjectSettingsInput = { tags: ['help wanted'], prMode: 'reviewed' };

/** Opens an issue on GitHub as sample-maintainer, and caches it for the project as a sync would. */
async function tagged(repo: string, title = 'Keep the trailing slash in rewrites'): Promise<string> {
  const number = github.openIssue(repo, { title, body: 'A rewrite from /docs/ drops the slash.', labels: ['help wanted'], by: BY });
  const issue = `${repo}#${String(number)}`;
  await saveIssues(env.DB, [{ issue, project: repo, title, labels: ['help wanted'], linkedPr: null, syncedAt: Date.now() }]);
  return issue;
}

const numberOf = (issue: string) => Number(issue.slice(issue.indexOf('#') + 1));

/** Claims the issue with claim_issue, as the donor's agent does. */
async function claim(d: Donor, issue: string): Promise<{ claimId: string; start: string }> {
  const result = await call(d, 'claim_issue', { sessionId: d.sessionId, issue });
  if (result.isError) throw new Error(textOf(result));
  const content = result.structuredContent as { claim: { claimId: string }; clone: { commit: string } };
  return { claimId: content.claim.claimId, start: content.clone.commit };
}

function submit(d: Donor, claimId: string, files: Record<string, string | null>, extra: Record<string, unknown> = {}) {
  return call(d, 'submit_work', {
    claimId,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    ...NOTES,
    ...extra,
  });
}

const branchOf = (issue: string, claimId: string) => `goodfirsttoken/issue-${String(numberOf(issue))}-${claimId}`;

// Reading the fake's state, the way a test reads GitHub without a token.

type RepoRecord = FakeState['repos'][string];

function repoState(name: string): RepoRecord {
  const found = github.state.repos[name.toLowerCase()];
  if (!found) throw new Error(`the fake has no repo ${name}`);
  return found;
}

function commitAt(sha: string | undefined) {
  const found = sha === undefined ? undefined : github.state.objects[sha];
  if (found?.type !== 'commit') throw new Error(`the fake has no commit ${String(sha)}`);
  return found;
}

function decode(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

/** Every file at a branch or commit, by path. */
function filesAt(repo: string, ref: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (oid: string, prefix: string) => {
    const tree = github.state.objects[oid];
    if (tree?.type !== 'tree') throw new Error(`the fake has no tree ${oid}`);
    for (const entry of tree.entries) {
      const object = github.state.objects[entry.oid];
      if (object?.type === 'blob') files.set(`${prefix}${entry.name}`, decode(object.base64));
      else walk(entry.oid, `${prefix}${entry.name}/`);
    }
  };
  walk(commitAt(repoState(repo).branches[ref] ?? ref).tree, '');
  return files;
}

/** The issue as the fake holds it. */
function issueState(issue: string) {
  const found = repoState(issue.slice(0, issue.indexOf('#'))).issues[String(numberOf(issue))];
  if (!found) throw new Error(`the fake has no issue ${issue}`);
  return found;
}

/** The calls that wrote to GitHub: every call but a REST read and a GraphQL query. */
function writes(calls: RecordedCall[]): string[] {
  return calls.filter((c) => c.method !== 'GET' && !c.operation.startsWith('query')).map((c) => c.operation);
}

/** The PRs someone opened in a repo. */
function pullsBy(repo: string, login: string) {
  return Object.values(repoState(repo).issues).filter((issue) => issue.pull !== null && issue.user === login);
}

function prOf(repo: string, number: number) {
  return { repo, number, url: `${github.webUrl}/${repo}/pull/${String(number)}` };
}

/** The GitHub token the fake gave `login`'s agent when it signed in. */
function agentToken(login: string): string {
  const found = Object.entries(github.state.tokens).find(
    ([, grant]) => grant.clientId === OAUTH_APP.clientId && grant.login === login,
  );
  if (!found) throw new Error(`${login} has no agent token`);
  return found[0];
}

/** Calls GitHub's API with a token, as a call to the Worker would. */
async function asGitHub(token: string, method: string, path: string, body: unknown): Promise<void> {
  const response = await github.fetch(`${github.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'goodfirsttoken-tests', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub answered ${String(response.status)}`);
}

/** An admin removes the project at its maintainers' request, which puts its repo on the do-not-list. */
async function removeProject(repo: string) {
  await savePerson(env.DB, admin, Date.now());
  const configured = env.ADMIN_GITHUB_IDS;
  env.ADMIN_GITHUB_IDS = String(admin.githubId);
  try {
    const removed = await adminRemoveProject({ ...admin, gitHubToken: () => Promise.resolve(null) }, { repo }, Date.now());
    if (!removed.ok) throw new Error(removed.refusal.message);
  } finally {
    env.ADMIN_GITHUB_IDS = configured;
  }
}

describe('where the work goes', () => {
  test('a donor who can push to the code repo gets a branch there, and GitHub signs the commit and names them its author', async () => {
    await project(APP, automatic);
    const issue = await tagged(APP);
    repoState(APP).collaborators.kenji = 'write';
    const kenji = await donor('kenji');
    const { claimId, start } = await claim(kenji, issue);

    const result = await submit(kenji, claimId, { 'src/rewrite.ts': 'export const keepSlash = true;\n' });

    const branch = branchOf(issue, claimId);
    const sha = repoState(APP).branches[branch];
    expect(result.structuredContent).toMatchObject({ claimId, issue, branch: { repo: APP, name: branch }, commit: { sha } });
    const commit = commitAt(sha);
    expect(commit.parents).toEqual([start]);
    expect(commit.author.login).toBe('kenji');
    expect(commit.committer.login).toBe('web-flow');
    expect(commit.signedByGitHub).toBe(true);
    expect(commit.message).toBe(
      `Keep the trailing slash in rewrites\n\n${NOTES.summary}\n\nAssisted-by: claude-code (claude-opus-5-5)`,
    );
    expect(filesAt(APP, branch).get('src/rewrite.ts')).toBe('export const keepSlash = true;\n');
    expect(github.state.repos['kenji/sample-app']).toBeUndefined();
    const [pull] = pullsBy(APP, 'kenji');
    expect(pull?.pull).toMatchObject({ head: { repo: APP, ref: branch, sha }, base: { ref: 'main' } });
    expect(lastCalls().map((c) => c.operation)).not.toContain('POST /repos/{owner}/{repo}/forks');
  });

  test("a donor who can't push gets a fork, made for them when they have none, and the PR comes from it", async () => {
    await project(APP, automatic);
    const issue = await tagged(APP);
    const sam = await donor('sam');
    const { claimId, start } = await claim(sam, issue);

    const result = await submit(sam, claimId, { 'src/rewrite.ts': 'export const keepSlash = true;\n' }, {
      title: 'Keep the trailing slash when a rewrite runs',
    });

    const branch = branchOf(issue, claimId);
    const fork = repoState('sam/sample-app');
    const sha = fork.branches[branch];
    expect(fork.forkOf).toBe(APP);
    expect(repoState(APP).branches[branch]).toBeUndefined();
    expect(commitAt(sha)).toMatchObject({ parents: [start], author: { login: 'sam' }, signedByGitHub: true });
    const [pull] = pullsBy(APP, 'sam');
    if (!pull) throw new Error('no PR');
    expect(pull.title).toBe('Keep the trailing slash when a rewrite runs');
    expect(pull.pull).toMatchObject({ head: { repo: 'sam/sample-app', owner: 'sam', ref: branch, sha }, base: { ref: 'main' } });
    expect(result.structuredContent).toMatchObject({
      state: 'pr_opened',
      branch: { repo: 'sam/sample-app', name: branch },
      pr: prOf(APP, pull.number),
      reviewReason: null,
    });
  });

  test('a donor who already has a fork gets the branch in it, and no second fork', async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);

    const result = await submit(priya, claimId, { 'src/rewrite.ts': 'export const keepSlash = true;\n' });

    expect(result.structuredContent).toMatchObject({ branch: { repo: 'priya/sample-app' } });
    expect(repoState('priya/sample-app').branches[branchOf(issue, claimId)]).toBeDefined();
    expect(Object.keys(github.state.repos).filter((name) => name.startsWith('priya/sample-app'))).toEqual(['priya/sample-app']);
  });

  test("a new fork GitHub is still making is waited for, and one still not ready refuses the submit, which works once it is", async () => {
    await project(APP, reviewed);
    const [first, second] = [await tagged(APP), await tagged(APP)];
    const sam = await donor('sam');
    const lena = await donor('lena');
    const samClaim = await claim(sam, first);
    const lenaClaim = await claim(lena, second);

    // Ready within the waits, which add up to 3.5 seconds.
    github.forkDelayMs = 2000;
    const waited = await submit(sam, samClaim.claimId, { 'a.txt': 'a\n' });
    const busy = lastCalls().filter((c) => c.status === 409);
    // Not ready for an hour.
    github.forkDelayMs = HOUR;
    const refused = await submit(lena, lenaClaim.claimId, { 'b.txt': 'b\n' });

    expect(waited.structuredContent).toMatchObject({ state: 'awaiting_review', branch: { repo: 'sam/sample-app' } });
    expect(busy.length).toBeGreaterThan(0);
    expect(refusalOf(refused)).toBe('fork_not_ready');
    expect(textOf(refused)).toContain('Call submit_work again in a minute');
    expect(repoState('lena/sample-app').branches[branchOf(second, lenaClaim.claimId)]).toBeUndefined();
    expect((await issueRoom(env.ISSUE_ROOM, second).snapshot()).claims[0]?.state).toBe('active');

    repoState('lena/sample-app').gitReadyAt = null;
    const again = await submit(lena, lenaClaim.claimId, { 'b.txt': 'b\n' });
    expect(again.structuredContent).toMatchObject({ state: 'awaiting_review', branch: { repo: 'lena/sample-app' } });
  });

  test('the branch starts at the start commit, however far the default branch moved since the claim', async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId, start } = await claim(priya, issue);
    github.commitFiles(APP, { 'CHANGELOG.md': 'A change the maintainers made meanwhile.\n' }, BY);

    await submit(priya, claimId, { 'src/rewrite.ts': 'export const keepSlash = true;\n' });
    await call(priya, 'open_pr', { claimId });

    const branch = branchOf(issue, claimId);
    expect(commitAt(repoState('priya/sample-app').branches[branch]).parents).toEqual([start]);
    expect(repoState(APP).branches.main).not.toBe(start);
    expect(filesAt('priya/sample-app', branch).has('CHANGELOG.md')).toBe(false);
    const [pull] = pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref === branch);
    expect(pull?.pull).toMatchObject({ base: { ref: 'main' } });
  });
});

describe('automatic and reviewed', () => {
  test('in automatic mode the PR opens with the disclosure, and the claim, its room, and the PRs table all record it', async () => {
    await project(APP, automatic);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);

    const result = await submit(priya, claimId, { 'src/rewrite.ts': 'export const keepSlash = true;\n' }, { tokenEstimate: 4200 });

    const [pull] = pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref === branchOf(issue, claimId));
    if (!pull) throw new Error('no PR');
    const pr = prOf(APP, pull.number);
    expect(result.structuredContent).toMatchObject({ state: 'pr_opened', pr, reviewReason: null });
    expect(textOf(result)).toContain(`PR #${String(pull.number)}: ${pr.url}`);
    expect(pull.body).toBe(
      `${NOTES.summary}\n\nWhat claude-code (claude-opus-5-5) checked: ${NOTES.checks}\n\nCloses #${String(numberOf(issue))}\n\n${DISCLOSURE}`,
    );
    const room = await issueRoom(env.ISSUE_ROOM, issue).snapshot();
    expect(room.claims).toMatchObject([{ id: claimId, state: 'pr_opened', pr, tokenEstimate: 4200 }]);
    expect(room.prs).toEqual([pr]);
    expect(await getPr(env.DB, claimId)).toMatchObject({ pr, state: 'open' });
    const history = await issueRoom(env.ISSUE_ROOM, issue).history();
    expect(history.map((e) => [e.kind, e.text])).toEqual([
      ['claimed', 'claimed the issue'],
      ['submitted', 'submitted the work'],
      ['pr_opened', `opened PR ${APP}#${String(pull.number)}`],
    ]);
  });

  test('in reviewed mode the work waits in the review queue, and open_pr opens it once the donor has read the diff', async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId, start } = await claim(priya, issue);

    // main has src/rewrite.ts with keepQuery, from priya's merged PR.
    const result = await submit(priya, claimId, {
      'src/rewrite.ts': 'export const keepSlash = true;\nexport const keepQuery = true;\n',
      'README.md': null,
    });
    const queued = await call(priya, 'my_work');
    const opened = await call(priya, 'open_pr', { claimId });
    const twice = await call(priya, 'open_pr', { claimId });
    const after = await call(priya, 'my_work');

    const branch = branchOf(issue, claimId);
    const diffUrl = `${github.webUrl}/priya/sample-app/compare/${start}...${branch}`;
    expect(result.structuredContent).toMatchObject({ state: 'awaiting_review', pr: null, reviewReason: 'reviewed_mode', diffUrl });
    expect(textOf(result)).toContain("The work is in the donor's review queue because the project reviews agent PRs.");
    expect(queued.structuredContent?.readyToOpen).toEqual([
      expect.objectContaining({
        claimId,
        issue,
        diffUrl,
        additions: 1,
        deletions: 2,
        agent: 'claude-code',
        model: 'claude-opus-5-5',
        summary: NOTES.summary,
        checks: NOTES.checks,
        reviewReason: 'reviewed_mode',
        prOnIssue: null,
        personWrittenDescription: false,
        openable: true,
        reason: null,
      }),
    ]);
    const [pull] = pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref === branch);
    if (!pull) throw new Error('no PR');
    expect(opened.structuredContent).toEqual({ claimId, issue, state: 'pr_opened', pr: prOf(APP, pull.number), prOnIssue: null });
    expect(refusalOf(twice)).toBe('pr_already_opened');
    expect(after.structuredContent?.readyToOpen).toEqual([]);
    expect(await getPr(env.DB, claimId)).toMatchObject({ state: 'open' });
  });

  test('a project that wants a person-written description waits for the donor to write it, and the PR carries their words', async () => {
    await project(APP, { ...automatic, personWrittenDescription: true });
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);

    const result = await submit(priya, claimId, { 'src/rewrite.ts': 'export const keepSlash = true;\n' });
    const unwritten = await call(priya, 'open_pr', { claimId });
    const words = 'I kept the slash because /docs/ and /docs are different pages here.';
    const opened = await call(priya, 'open_pr', { claimId, description: words });

    expect(result.structuredContent).toMatchObject({ state: 'awaiting_review', reviewReason: 'person_written_description' });
    expect(refusalOf(unwritten)).toBe('description_required');
    expect(opened.isError).toBeFalsy();
    const [pull] = pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref === branchOf(issue, claimId));
    expect(pull?.body).toBe(`${words}\n\nCloses #${String(numberOf(issue))}\n\n${DISCLOSURE}`);
  });

  test('a PR opened on the issue between the claim and the submit sends the work to review, which names that PR', async () => {
    await project(APP, automatic);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);
    // Someone opens a PR on GitHub. The cache and the room don't know of it.
    const theirs = github.openPullRequest(APP, { title: 'Another fix', body: `Fixes #${String(numberOf(issue))}`, by: 'lena' });

    const result = await submit(priya, claimId, { 'src/rewrite.ts': 'export const keepSlash = true;\n' });
    const queued = await call(priya, 'my_work');
    const opened = await call(priya, 'open_pr', { claimId });

    expect(result.structuredContent).toMatchObject({ state: 'awaiting_review', pr: null, reviewReason: 'pr_exists' });
    expect(pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref === branchOf(issue, claimId))).toHaveLength(1);
    expect(queued.structuredContent?.readyToOpen).toEqual([expect.objectContaining({ reviewReason: 'pr_exists', prOnIssue: prOf(APP, theirs) })]);
    // The donor decided a second PR helps, and it opens, naming the other.
    expect(opened.structuredContent).toMatchObject({ state: 'pr_opened', prOnIssue: prOf(APP, theirs) });
  });

  test('a donor with as many open PRs in the project as it allows gets the next work in the review queue, and open_pr waits for one to close', async () => {
    await project(APP, { ...automatic, openPrsPerDonor: 1 });
    const [first, second] = [await tagged(APP), await tagged(APP)];
    const priya = await donor('priya');
    const one = await claim(priya, first);
    const two = await claim(priya, second);

    const opened = await submit(priya, one.claimId, { 'a.txt': 'a\n' });
    const held = await submit(priya, two.claimId, { 'b.txt': 'b\n' });
    const refused = await call(priya, 'open_pr', { claimId: two.claimId });

    expect(opened.structuredContent).toMatchObject({ state: 'pr_opened' });
    expect(held.structuredContent).toMatchObject({ state: 'awaiting_review', reviewReason: 'open_pr_cap' });
    expect(refusalOf(refused)).toBe('open_pr_cap');
  });
});

describe('when GitHub says no', () => {
  test("a PR GitHub won't open by itself leaves the work in the review queue, and open_pr gives GitHub's reason", async () => {
    await project(APP, automatic);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);
    // The repo turned PRs from outside collaborators off after the claim.
    repoState(APP).pullRequestCreationPolicy = 'collaborators_only';

    const result = await submit(priya, claimId, { 'a.txt': 'a\n' });
    const queued = await call(priya, 'my_work');
    const opened = await call(priya, 'open_pr', { claimId });

    expect(result.structuredContent).toMatchObject({ state: 'awaiting_review', pr: null, reviewReason: 'pr_refused' });
    expect(textOf(result)).toContain("because GitHub didn't open the PR. Ask the donor to read the diff, then try open_pr.");
    expect(queued.structuredContent?.readyToOpen).toEqual([expect.objectContaining({ claimId, reviewReason: 'pr_refused' })]);
    expect(refusalOf(opened)).toBe('github_refused');
    expect(textOf(opened)).toContain('Only collaborators can create pull requests in this repository.');
    expect((await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims[0]?.state).toBe('awaiting_review');
  });
});

describe('workflow files', () => {
  test('a change under .github/workflows/ goes to review even in automatic mode, and so does one spelled in another case', async () => {
    await project(APP, automatic);
    github.commitFiles(APP, { '.github/workflows/ci.yml': 'name: CI\non: [pull_request]\n' }, BY);
    const [first, second] = [await tagged(APP), await tagged(APP)];
    repoState(APP).collaborators.kenji = 'write';
    const kenji = await donor('kenji');
    const sam = await donor('sam');
    const kenjiClaim = await claim(kenji, first);
    const samClaim = await claim(sam, second);
    // The maintainers change the workflow after the claim. kenji's work
    // takes the same file, which GitHub lets a token without the workflow
    // scope commit, since main has it.
    github.commitFiles(APP, { '.github/workflows/ci.yml': 'name: CI\non: [pull_request, push]\n' }, BY);

    const workflow = await submit(kenji, kenjiClaim.claimId, {
      '.github/workflows/ci.yml': 'name: CI\non: [pull_request, push]\n',
      'src/rewrite.ts': 'export const keepSlash = true;\n',
    });
    const otherCase = await submit(sam, samClaim.claimId, { '.GitHub/Workflows/notes.md': 'Runs on every PR.\n' });

    expect(workflow.structuredContent).toMatchObject({ state: 'awaiting_review', pr: null, reviewReason: 'workflow_files' });
    expect(filesAt(APP, branchOf(first, kenjiClaim.claimId)).get('.github/workflows/ci.yml')).toBe('name: CI\non: [pull_request, push]\n');
    expect(otherCase.structuredContent).toMatchObject({ state: 'awaiting_review', pr: null, reviewReason: 'workflow_files' });
    expect([...pullsBy(APP, 'kenji'), ...pullsBy(APP, 'sam')]).toEqual([]);
  });

  test("a workflow change GitHub won't take from the donor's token is refused with GitHub's reason, and the claim goes on", async () => {
    await project(APP, automatic);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId, start } = await claim(priya, issue);

    const result = await submit(priya, claimId, { '.github/workflows/release.yml': 'name: Release\non: [push]\n' });

    expect(refusalOf(result)).toBe('github_refused');
    expect(textOf(result)).toContain('without `workflow` scope');
    expect(textOf(result)).toContain('Nothing was committed.');
    expect(textOf(result)).toContain('Leave that change out, and tell the donor to make it on GitHub themselves.');
    const branch = repoState('priya/sample-app').branches[branchOf(issue, claimId)];
    expect(branch === undefined || branch === start).toBe(true);
    expect((await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims[0]?.state).toBe('active');
    expect(await getSubmission(env.DB, claimId)).toBeNull();
  });
});

describe('what a submit commits', () => {
  test('a deletion removes a file, a deletion of a file that is not there changes nothing, and files the branch already holds leave nothing to commit', async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);
    const branch = branchOf(issue, claimId);

    const unchanged = await submit(priya, claimId, { 'README.md': README, 'never-there.txt': null });
    const madeBefore = repoState('priya/sample-app').branches[branch];
    const deleted = await submit(priya, claimId, { 'README.md': null, 'never-there.txt': null, 'src/new.ts': 'export {};\n' });
    const again = await submit(priya, claimId, { 'README.md': null, 'src/new.ts': 'export {};\n' });

    expect(refusalOf(unchanged)).toBe('no_changes');
    expect(madeBefore).toBeUndefined();
    expect(deleted.isError).toBeFalsy();
    const files = filesAt('priya/sample-app', branch);
    expect(files.has('README.md')).toBe(false);
    expect(files.get('src/new.ts')).toBe('export {};\n');
    expect(refusalOf(again)).toBe('no_changes');
  });

  test('submitting again adds a commit to the same branch, puts back the files it leaves out, and adds up the token estimates', async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);
    const branch = branchOf(issue, claimId);

    const first = await submit(
      priya,
      claimId,
      { 'README.md': '# sample-app\n\nChanged.\n', 'src/a.ts': 'export const a = 1;\n', 'src/extra.ts': 'export {};\n' },
      { tokenEstimate: 1000 },
    );
    const firstSha = repoState('priya/sample-app').branches[branch];
    const second = await submit(priya, claimId, { 'src/a.ts': 'export const a = 2;\n' }, { tokenEstimate: 500 });

    const files = filesAt('priya/sample-app', branch);
    expect(first.structuredContent).toMatchObject({ state: 'awaiting_review' });
    expect(second.structuredContent).toMatchObject({ state: 'awaiting_review', reviewReason: 'reviewed_mode' });
    expect(commitAt(repoState('priya/sample-app').branches[branch]).parents).toEqual([firstSha]);
    expect(files.get('README.md')).toBe(README);
    expect(files.get('src/a.ts')).toBe('export const a = 2;\n');
    expect(files.has('src/extra.ts')).toBe(false);
    const room = issueRoom(env.ISSUE_ROOM, issue);
    expect((await room.snapshot()).claims[0]).toMatchObject({ state: 'awaiting_review', tokenEstimate: 1500 });
    expect((await room.history()).filter((e) => e.kind === 'submitted').map((e) => e.text)).toEqual([
      'submitted the work',
      'submitted more work',
    ]);
    expect(await getSubmission(env.DB, claimId)).toMatchObject({ paths: ['src/a.ts'], repo: 'priya/sample-app', branch });
  });

  test("a submit to a claim whose PR is open commits to the PR's branch and opens no second PR, and one whose PR merged is refused", async () => {
    await project(APP, automatic);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);
    const branch = branchOf(issue, claimId);

    const opened = await submit(priya, claimId, { 'a.txt': 'one\n' });
    const fixed = await submit(priya, claimId, { 'a.txt': 'two\n' });
    const [pull] = pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref === branch);
    if (!pull) throw new Error('no PR');
    github.mergePullRequest(APP, pull.number, BY);
    await setPrState(env.DB, claimId, 'merged', Date.now());
    const late = await submit(priya, claimId, { 'a.txt': 'three\n' });

    expect(opened.structuredContent).toMatchObject({ state: 'pr_opened', pr: prOf(APP, pull.number) });
    expect(fixed.structuredContent).toMatchObject({ state: 'pr_opened', pr: prOf(APP, pull.number), reviewReason: null });
    expect(pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref === branch)).toHaveLength(1);
    expect(filesAt('priya/sample-app', branch).get('a.txt')).toBe('two\n');
    expect(refusalOf(late)).toBe('pr_closed');
    expect(lastCalls()).toEqual([]);
  });

  test('a commit an earlier call made and never recorded, as when it died after the commit, is recorded by the same submit again', async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId, start } = await claim(priya, issue);
    const branch = branchOf(issue, claimId);
    // What the earlier call did on GitHub with priya's token before it died.
    const token = agentToken('priya');
    await asGitHub(token, 'POST', '/repos/priya/sample-app/git/refs', { ref: `refs/heads/${branch}`, sha: start });
    await asGitHub(token, 'POST', '/graphql', {
      query: 'mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
      variables: {
        input: {
          branch: { repositoryNameWithOwner: 'priya/sample-app', branchName: branch },
          expectedHeadOid: start,
          message: { headline: 'Keep the trailing slash in rewrites' },
          fileChanges: { additions: [{ path: 'a.txt', contents: btoa('a\n') }] },
        },
      },
    });
    const landed = repoState('priya/sample-app').branches[branch];

    const result = await submit(priya, claimId, { 'a.txt': 'a\n' });
    const again = await submit(priya, claimId, { 'a.txt': 'a\n' });

    expect(landed).not.toBe(start);
    expect(result.structuredContent).toMatchObject({ state: 'awaiting_review', commit: { sha: landed } });
    expect(repoState('priya/sample-app').branches[branch]).toBe(landed);
    expect((await issueRoom(env.ISSUE_ROOM, issue).history()).filter((e) => e.kind === 'submitted')).toHaveLength(1);
    // Once it is recorded, the same files again are nothing new.
    expect(refusalOf(again)).toBe('no_changes');
  });

  test('an executable file, a symbolic link, and a submodule take no change and no deletion, and keep their modes', async () => {
    await project(APP, reviewed);
    github.commitFiles(
      APP,
      { 'bin/run.sh': 'echo run\n', 'bin/latest': 'run.sh', 'vendor/lib': 'c'.repeat(40) },
      BY,
      { modes: { 'bin/run.sh': '100755', 'bin/latest': '120000', 'vendor/lib': '160000' } },
    );
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);
    const branch = branchOf(issue, claimId);

    const tries: [Record<string, string | null>, string][] = [
      [{ 'bin/run.sh': 'echo walk\n' }, 'bin/run.sh is an executable file'],
      [{ 'bin/run.sh': null }, 'bin/run.sh is an executable file'],
      [{ 'bin/latest': 'walk.sh' }, 'bin/latest is a symbolic link'],
      [{ 'vendor/lib': 'd'.repeat(40) }, 'vendor/lib is a submodule'],
      [{ 'vendor/lib': null }, 'vendor/lib is a submodule'],
    ];
    for (const [files, says] of tries) {
      const refused = await submit(priya, claimId, { 'src/ok.ts': 'export {};\n', ...files });
      expect(refusalOf(refused), says).toBe('file_mode');
      expect(textOf(refused)).toContain(`${says} in the start commit, and submit_work changes only plain files, so nothing was committed.`);
      expect(writes(lastCalls()).filter((w) => !w.endsWith('/forks'))).toEqual([]);
    }
    // The same text as the file has changes nothing, so it goes through.
    const same = await submit(priya, claimId, { 'src/ok.ts': 'export {};\n', 'bin/run.sh': 'echo run\n' });

    expect(same.isError).toBeFalsy();
    const modes = (dir: string) => {
      const tree = github.state.objects[commitAt(repoState('priya/sample-app').branches[branch]).tree];
      const folder = tree?.type === 'tree' ? tree.entries.find((e) => e.name === dir) : undefined;
      const entries = folder === undefined ? undefined : github.state.objects[folder.oid];
      return entries?.type === 'tree' ? Object.fromEntries(entries.entries.map((e) => [e.name, e.mode ?? '100644'])) : {};
    };
    expect(modes('bin')).toEqual({ 'run.sh': '100755', latest: '120000' });
    expect(modes('vendor')).toEqual({ lib: '160000' });
  });

  test('putting back a file whose mode a commit would lose is refused', async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);
    const branch = branchOf(issue, claimId);
    await submit(priya, claimId, { 'tool.sh': 'echo one\n', 'a.txt': 'a\n' });
    // No submit gets a mode onto the branch, and a push to it stops the
    // next submit, so the test sets one in the fake's tree itself.
    const tree = github.state.objects[commitAt(repoState('priya/sample-app').branches[branch]).tree];
    const entry = tree?.type === 'tree' ? tree.entries.find((e) => e.name === 'tool.sh') : undefined;
    if (!entry) throw new Error('no tool.sh');
    entry.mode = '100755';

    const refused = await submit(priya, claimId, { 'a.txt': 'b\n' });

    expect(refusalOf(refused)).toBe('file_mode');
    expect(textOf(refused)).toContain(`tool.sh is an executable file in priya/sample-app:${branch}`);
  });

  test("keys and tokens in the agent's notes are replaced in the commit, the PR, and the review queue", async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);
    // Built here, so no file holds one.
    const token = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');

    await submit(priya, claimId, { 'a.txt': 'a\n' }, { summary: `Ran it with GITHUB_TOKEN=${token} set.`, checks: `curl -H "Authorization: Bearer ${token}"` });
    const queued = await call(priya, 'my_work');
    await call(priya, 'open_pr', { claimId });

    const [pull] = pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref === branchOf(issue, claimId));
    const commit = commitAt(repoState('priya/sample-app').branches[branchOf(issue, claimId)]);
    for (const text of [pull?.body ?? '', commit.message, JSON.stringify(queued.structuredContent)]) {
      expect(text).not.toContain(token);
      expect(text).toContain('[redacted]');
    }
  });
});

describe('the issue on GitHub', () => {
  // Each way an issue stops taking outside work after a claim, done on
  // GitHub by a maintainer, which neither the cache nor the room hears of.
  const failing: [string, (issue: string) => void, string][] = [
    [
      'closed',
      (issue) => {
        github.closeIssue(APP, numberOf(issue), BY);
      },
      'is closed on GitHub',
    ],
    [
      'deleted',
      (issue) => {
        // The fake's record of the issue goes, as a deleted issue goes from GitHub.
        Reflect.deleteProperty(repoState(APP).issues, String(numberOf(issue)));
      },
      'GitHub shows you no issue',
    ],
    [
      'untagged',
      (issue) => {
        issueState(issue).labels = [];
      },
      'no longer carries a tag',
    ],
    [
      'given an excluded tag',
      (issue) => {
        github.labelIssue(APP, numberOf(issue), 'needs design', BY);
      },
      'a label sample-owner/sample-app keeps for people',
    ],
    [
      'assigned to someone else',
      (issue) => {
        github.assignIssue(APP, numberOf(issue), 'lena', BY);
      },
      'has an assignee on GitHub',
    ],
  ];

  test.each(failing)(
    'an issue %s after the claim takes no submit and no PR, and nothing is written to GitHub',
    async (_, change, says) => {
      await project(APP, { ...automatic, prMode: 'reviewed', excludedTags: ['needs design'] });
      const [working, waiting] = [await tagged(APP), await tagged(APP)];
      const priya = await donor('priya');
      const one = await claim(priya, working);
      const two = await claim(priya, waiting);
      await submit(priya, two.claimId, { 'b.txt': 'b\n' });
      const branches = { ...repoState('priya/sample-app').branches };
      change(working);
      change(waiting);

      const submitted = await submit(priya, one.claimId, { 'a.txt': 'a\n' });
      const submitCalls = lastCalls();
      const queued = await call(priya, 'my_work');
      const opened = await call(priya, 'open_pr', { claimId: two.claimId });
      const openCalls = lastCalls();

      expect(refusalOf(submitted)).toBe('issue_not_eligible');
      expect(textOf(submitted)).toContain(says);
      expect(textOf(submitted)).toContain('Nothing was committed. Stop with release_claim and a reason.');
      expect(submitCalls.length).toBeGreaterThan(0);
      expect(writes(submitCalls)).toEqual([]);
      expect(refusalOf(opened)).toBe('issue_not_eligible');
      expect(textOf(opened)).toContain(says);
      expect(textOf(opened)).toContain('The work stays on its branch, and no PR opened.');
      expect(writes(openCalls)).toEqual([]);
      expect(repoState('priya/sample-app').branches).toEqual(branches);
      expect(pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref.startsWith('goodfirsttoken/'))).toEqual([]);
      expect(await getSubmission(env.DB, one.claimId)).toBeNull();
      expect((await issueRoom(env.ISSUE_ROOM, working).snapshot()).claims[0]?.state).toBe('active');
      expect((await issueRoom(env.ISSUE_ROOM, waiting).snapshot()).claims[0]?.state).toBe('awaiting_review');
      expect(queued.structuredContent?.readyToOpen).toEqual([
        expect.objectContaining({ claimId: two.claimId, openable: false, reason: expect.stringContaining(says) as string }),
      ]);
    },
  );

  test('an issue assigned to the donor takes their work, and a claim whose PR is open takes fixes whatever the issue says', async () => {
    await project(APP, automatic);
    const [assigned, relabelled] = [await tagged(APP), await tagged(APP)];
    const priya = await donor('priya');
    const one = await claim(priya, assigned);
    const two = await claim(priya, relabelled);
    github.assignIssue(APP, numberOf(assigned), 'priya', BY);

    const mine = await submit(priya, one.claimId, { 'a.txt': 'a\n' });
    const opened = await submit(priya, two.claimId, { 'b.txt': 'b\n' });
    // With the PR open, a maintainer relabels the issue and assigns a reviewer.
    issueState(relabelled).labels = ['in review'];
    github.assignIssue(APP, numberOf(relabelled), 'lena', BY);
    const fixed = await submit(priya, two.claimId, { 'b.txt': 'b, fixed\n' });

    expect(mine.structuredContent).toMatchObject({ state: 'pr_opened' });
    expect(opened.structuredContent).toMatchObject({ state: 'pr_opened' });
    expect(fixed.structuredContent).toMatchObject({ state: 'pr_opened', reviewReason: null });
    expect(filesAt('priya/sample-app', branchOf(relabelled, two.claimId)).get('b.txt')).toBe('b, fixed\n');
  });
});

describe('who can submit and open a PR', () => {
  test("a maintainer's token is never used for a donor's work, even on the maintainer's own project with their agent connected", async () => {
    await project(APP, automatic);
    const issue = await tagged(APP);
    const owner = await donor('sample-maintainer');
    await call(owner, 'project_status', { repo: APP });
    // The maintainer holds a claim on the same issue, and submits it with their own token.
    const ownClaim = await claim(owner, issue);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);

    const mine = await submit(owner, ownClaim.claimId, { 'mine.txt': 'the maintainer\n' });
    const donorCalls = github.calls.length;
    // The maintainer's PR is on the issue now, so the donor's work waits for them.
    const theirs = await submit(priya, claimId, { 'theirs.txt': 'the donor\n' });
    const opened = await call(priya, 'open_pr', { claimId });

    const madeForPriya = github.calls.slice(donorCalls).filter((c) => c.url.startsWith(github.apiUrl));
    expect(madeForPriya.length).toBeGreaterThan(0);
    expect(madeForPriya.filter((c) => c.login !== 'priya')).toEqual([]);
    expect(github.calls.slice(0, donorCalls).some((c) => c.login === 'sample-maintainer')).toBe(true);
    // The maintainer's own work ran as them, on a branch in their repo.
    expect(mine.structuredContent).toMatchObject({ state: 'pr_opened', branch: { repo: APP } });
    expect(theirs.structuredContent).toMatchObject({ reviewReason: 'pr_exists', branch: { repo: 'priya/sample-app' } });
    expect(opened.structuredContent).toMatchObject({ state: 'pr_opened' });
    const [pull] = pullsBy(APP, 'priya');
    expect(pull?.pull?.head.repo).toBe('priya/sample-app');
    expect(commitAt(pull?.pull?.head.sha).author.login).toBe('priya');
  });

  test("someone else's claim is refused before anything reaches GitHub", async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const kenji = await donor('kenji');
    const { claimId } = await claim(priya, issue);

    const theirSubmit = await submit(kenji, claimId, { 'a.txt': 'a\n' });
    const theirCalls = lastCalls();
    await submit(priya, claimId, { 'a.txt': 'a\n' });
    const theirOpen = await call(kenji, 'open_pr', { claimId });

    expect(refusalOf(theirSubmit)).toBe('not_claim_owner');
    expect(theirCalls).toEqual([]);
    expect(refusalOf(theirOpen)).toBe('not_claim_owner');
    expect(lastCalls()).toEqual([]);
    expect(pullsBy(APP, 'kenji')).toEqual([]);
  });

  test('a claim on a project on the do-not-list takes no submit and no PR, and nothing reaches GitHub', async () => {
    await project(APP, reviewed);
    const [working, waiting] = [await tagged(APP), await tagged(APP)];
    const priya = await donor('priya');
    const one = await claim(priya, working);
    const two = await claim(priya, waiting);
    await submit(priya, two.claimId, { 'a.txt': 'a\n' });
    await removeProject(APP);

    const submitted = await submit(priya, one.claimId, { 'b.txt': 'b\n' });
    const submitCalls = lastCalls();
    const opened = await call(priya, 'open_pr', { claimId: two.claimId });
    const openCalls = lastCalls();
    const work = await call(priya, 'my_work');

    expect(refusalOf(submitted)).toBe('project_not_open');
    expect(textOf(submitted)).toContain('on the do-not-list');
    expect(submitCalls).toEqual([]);
    expect(refusalOf(opened)).toBe('project_not_open');
    expect(openCalls).toEqual([]);
    expect(pullsBy(APP, 'priya').filter((p) => p.pull?.head.ref.startsWith('goodfirsttoken/'))).toEqual([]);
    expect(work.structuredContent?.readyToOpen).toEqual([
      expect.objectContaining({ claimId: two.claimId, openable: false, reason: expect.stringContaining('do-not-list') as string }),
    ]);
  });

  test('a blocked donor, a paused project, and a released claim take no submit, and nothing reaches GitHub', async () => {
    await project(APP, reviewed);
    await project(TOOLS, reviewed);
    const [blockedIssue, releasedIssue] = [await tagged(APP), await tagged(APP)];
    const pausedIssue = await tagged(TOOLS);
    const priya = await donor('priya');
    const kenji = await donor('kenji');
    const blocked = await claim(priya, blockedIssue);
    const released = await claim(kenji, releasedIssue);
    const paused = await claim(kenji, pausedIssue);
    await call(kenji, 'release_claim', { claimId: released.claimId, reason: 'Out of time.' });
    await savePerson(env.DB, admin, Date.now());
    await blockDonor(env.DB, { githubId: people.priya.githubId, reason: 'Spam.', blockedBy: admin.githubId }, Date.now());
    await setProjectStatus(env.DB, TOOLS, { status: 'paused', reason: 'Taking a break.', changedBy: maintainer.githubId }, Date.now());

    const results = [
      await submit(priya, blocked.claimId, { 'a.txt': 'a\n' }),
      await submit(kenji, released.claimId, { 'a.txt': 'a\n' }),
      await submit(kenji, paused.claimId, { 'a.txt': 'a\n' }),
    ];

    expect(results.map(refusalOf)).toEqual(['donor_blocked', 'claim_released', 'project_not_open']);
    expect(pathCalls.filter((p) => p.tool === 'submit_work').flatMap((p) => p.calls)).toEqual([]);
  });

  test('files that break the rules never reach the tool: a path out of the repo or into .git, or a binary file', async () => {
    await project(APP, reviewed);
    const issue = await tagged(APP);
    const priya = await donor('priya');
    const { claimId } = await claim(priya, issue);

    const outside = await submit(priya, claimId, { '../outside.ts': 'x' });
    const gitDir = await submit(priya, claimId, { '.git/hooks/pre-commit': 'x' });
    const binary = await submit(priya, claimId, { 'logo.png': '\u0089PNG\r\n\u001a\n\u0000' });

    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain('files.0.path: must be a path inside the repo');
    expect(textOf(gitDir)).toContain('files.0.path: must be a path inside the repo');
    expect(textOf(binary)).toContain('files.0.content: must be text');
    expect(pathCalls.flatMap((p) => p.calls)).toEqual([]);
    expect((await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims[0]?.state).toBe('active');
  });
});
