import type { ProjectSettingsInput } from '@goodfirsttoken/core';
import type { GitHubFake, RecordedCall } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { createProject, getClaim, getPr, getSubmission, saveIssues, savePerson } from '../../src/db';
import { recordClearedPrs } from '../../src/sync/cleared';
import { ALLOWANCES } from '../../src/sync/scheduled';
import { issueRoom } from '../../src/rooms/issue-room';
import { APP as OAUTH_APP, Browser, location, signIn, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { freshNumbers, jobDeps } from '../sync/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// The server writes nothing to GitHub for a donor's work
// (docs/specs/agent-submits.md). Each path a donor's work takes runs here
// through the whole Worker against the GitHub fake: submit_work with a pushed branch,
// submit_work with files, which older skills sent and the server refuses,
// open_pr, record_pr, my_work, Open PR on /me, and the job that records
// cleared PRs. The donor's own tools push the branch and open the PR, with a
// token of their own from no OAuth app, and those calls are kept apart.
// Every other call to GitHub must be a read. The second test is #121: an
// organization that restricts OAuth apps refuses every write from the
// site's app, and the work still goes from a claim to a recorded PR. Every
// project, issue, and file here is made up.

const APP = 'sample-owner/sample-app';
const BY = 'sample-maintainer';
const maintainer = { githubId: 1009, login: BY };
const NOTES = {
  summary: 'Keeps the trailing slash when a rewrite runs.',
  checks: 'pnpm test: 12 passing.',
  agent: 'claude-code',
  model: 'claude-opus-5-5',
};
const TRAILED = 'Keep the trailing slash in rewrites\n\nAssisted-by: claude-code (claude-opus-5-5)';

let github: GitHubFake;
/** The places in github.calls of the calls the donor's own tools made, which the test makes. */
let ownCalls: Set<number>;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  github.forkDelayMs = 0;
  ownCalls = new Set();
  freshNumbers(github, APP);
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await savePerson(env.DB, maintainer, Date.now());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Whether a call wrote to GitHub: any method but GET, or a GraphQL mutation. */
function isWrite(call: RecordedCall): boolean {
  return call.method !== 'GET' && !call.operation.startsWith('query');
}

/** The calls to GitHub's API the donor's own tools didn't make: the Worker's and the job's. */
function serverCalls(): RecordedCall[] {
  return github.calls.filter((c, i) => c.url.startsWith(github.apiUrl) && !ownCalls.has(i));
}

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Donor {
  agent: ConnectedAgent;
  login: string;
  sessionId: string;
}

async function donor(login: string): Promise<Donor> {
  const agent = await connectAgent(github, login);
  const started = (await agent.client.callTool({ name: 'start_session', arguments: { agent: 'claude-code', budget: { kind: 'until_limit' } } })) as Result;
  return { agent, login, sessionId: String(started.structuredContent?.sessionId) };
}

async function call(d: Donor, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await d.agent.client.callTool({ name, arguments: args })) as Result;
}

const textOf = (result: Result) => result.content.map((c) => c.text).join('\n');
const refusalOf = (result: Result) => (result.isError ? (/^Refused \((\w+)\)/.exec(textOf(result))?.[1] ?? 'error') : null);

async function project(settings: ProjectSettingsInput) {
  await createProject(env.DB, { repo: APP, status: 'approved', source: 'registered', policy: null, settings, addedBy: maintainer.githubId }, Date.now());
}

async function tagged(): Promise<string> {
  const title = 'Keep the trailing slash in rewrites';
  const number = github.openIssue(APP, { title, body: 'A rewrite from /docs/ drops the slash.', labels: ['help wanted'], by: BY });
  const issue = `${APP}#${String(number)}`;
  await saveIssues(env.DB, [{ issue, project: APP, title, labels: ['help wanted'], linkedPr: null, syncedAt: Date.now() }]);
  return issue;
}

async function claim(d: Donor, issue: string): Promise<string> {
  const claimed = await call(d, 'claim_issue', { sessionId: d.sessionId, issue });
  if (claimed.isError) throw new Error(textOf(claimed));
  return (claimed.structuredContent as { claim: { claimId: string } }).claim.claimId;
}

/** A call to GitHub's API with `token`, kept apart as one the donor's own tools made. */
async function asOwnTools(token: string, method: string, path: string, body: unknown): Promise<Response> {
  const at = github.calls.length;
  const response = await github.fetch(`${github.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'goodfirsttoken-tests', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  for (let i = at; i < github.calls.length; i++) ownCalls.add(i);
  return response;
}

/**
 * Pushes the claim's branch to the donor's fork as their own git would,
 * making the fork with their own token when they have none, and gives the
 * branch as submit_work takes it.
 */
async function push(d: Donor, claimId: string, files: Record<string, string>) {
  const held = await getClaim(env.DB, claimId);
  if (held === null) throw new Error(`no claim ${claimId}`);
  const fork = `${d.login}/sample-app`;
  if (!(fork in github.state.repos)) {
    const made = await asOwnTools(github.tokenFor(d.login), 'POST', `/repos/${APP}/forks`, {});
    expect(made.status).toBe(202);
    const record = github.state.repos[fork];
    if (record) record.gitReadyAt = null;
  }
  const name = `goodfirsttoken/issue-${held.issue.slice(held.issue.indexOf('#') + 1)}-${claimId}`;
  const branches = github.state.repos[fork]?.branches;
  if (!branches) throw new Error(`no fork ${fork}`);
  branches[name] ??= held.startCommit;
  return { repo: fork, name, head: github.commitFiles(fork, files, d.login, { branch: name, message: TRAILED }) };
}

interface ToOpen {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  compareUrl: string;
}

/**
 * Opens the PR as the donor does on GitHub's form at the compare page link,
 * with the title and body the link fills in, and their own token. Gives its
 * link.
 */
async function openOnComparePage(login: string, toOpen: ToOpen): Promise<string> {
  const form = new URL(toOpen.compareUrl);
  const [base = '', head = ''] = form.pathname.slice(form.pathname.indexOf('/compare/') + '/compare/'.length).split('...');
  const opened = await asOwnTools(github.tokenFor(login), 'POST', `/repos/${toOpen.repo}/pulls`, {
    title: form.searchParams.get('title'),
    body: form.searchParams.get('body'),
    head: decodeURIComponent(head),
    base: decodeURIComponent(base),
  });
  expect(opened.status).toBe(201);
  const answer: { html_url: string } = await opened.json();
  return answer.html_url;
}

const runJob = () => recordClearedPrs(jobDeps(github, ALLOWANCES.cleared));

describe("the server's calls to GitHub for a donor's work", () => {
  test('every donor tool path, from a submit to a recorded PR, makes reads alone, and the donor\'s own tools make the writes', async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const [byTool, byPage] = [await tagged(), await tagged()];
    const priya = await donor('priya');
    const viaTool = await claim(priya, byTool);
    const viaPage = await claim(priya, byPage);

    // A submit with files, as an older skill sent, is refused.
    const files = await call(priya, 'submit_work', { claimId: viaTool, files: [{ path: 'a.txt', content: 'a\n' }], onto: 'b'.repeat(40), ...NOTES });
    // A pushed branch is taken, and waits in the review queue.
    const submitted = await call(priya, 'submit_work', { claimId: viaTool, branch: await push(priya, viaTool, { 'a.txt': 'a\n' }), ...NOTES });
    await call(priya, 'submit_work', { claimId: viaPage, branch: await push(priya, viaPage, { 'b.txt': 'b\n' }), ...NOTES });
    const queued = await call(priya, 'my_work', {});
    // open_pr clears one, and the donor opens its PR and records it with record_pr.
    const cleared = await call(priya, 'open_pr', { claimId: viaTool });
    const toolPr = await openOnComparePage('priya', cleared.structuredContent?.toOpen as ToOpen);
    const recorded = await call(priya, 'record_pr', { claimId: viaTool, pr: toolPr });
    // Open PR on /me clears the other, the donor opens its PR on GitHub's
    // form, and the job records it.
    const browser = new Browser();
    await signIn(browser, github, 'priya');
    const posted = await browser.post('/me', { action: 'open_pr', claim: viaPage });
    const page = await (await browser.fetch(`${location(posted).pathname}${location(posted).search}`)).text();
    const listed = await call(priya, 'my_work', {});
    const pageItem = (listed.structuredContent?.readyToOpen as { claimId: string; toOpen: ToOpen | null }[]).find((item) => item.claimId === viaPage);
    if (!pageItem?.toOpen) throw new Error('the work /me cleared has no link');
    await openOnComparePage('priya', pageItem.toOpen);
    const run = await runJob();
    const after = await call(priya, 'my_work', {});

    expect(refusalOf(files)).toBe('skill_outdated');
    expect(submitted.structuredContent).toMatchObject({ reviewReason: 'reviewed_mode' });
    expect(queued.structuredContent?.readyToOpen).toHaveLength(2);
    expect(recorded.structuredContent).toMatchObject({ state: 'pr_opened', pr: { url: toolPr } });
    expect(posted.status).toBe(303);
    expect(page).toContain(`The PR for ${byPage} is ready to open.`);
    expect(run).toMatchObject({ recorded: 1, failed: 0, stopped: null });
    expect((await issueRoom(env.ISSUE_ROOM, byPage).snapshot()).claims[0]?.state).toBe('pr_opened');
    expect(after.structuredContent?.readyToOpen).toEqual([]);

    // The server's own calls: many, every one a read, each with a token of
    // the site's OAuth app or the job's service token.
    const made = serverCalls();
    expect(made.length).toBeGreaterThan(20);
    expect(made.filter(isWrite).map((c) => `${c.method} ${c.operation} as ${c.login ?? 'no one'}`)).toEqual([]);
    expect(made.filter((c) => c.token === null || (github.state.tokens[c.token]?.clientId !== OAUTH_APP.clientId && c.token !== env.GH_SERVICE_TOKEN))).toEqual([]);
    // The record holds the writes, so the check above would see one: the
    // donor's own tools made them.
    const own = github.calls.filter((_, i) => ownCalls.has(i));
    expect(own.filter(isWrite).map((c) => c.operation)).toEqual([
      'POST /repos/{owner}/{repo}/pulls',
      'POST /repos/{owner}/{repo}/pulls',
    ]);
  });

  test("in an organization that restricts OAuth apps, work goes from a claim to a recorded PR opened on the compare page, by record_pr and by the job (#121)", async () => {
    await project({ tags: ['help wanted'], prMode: 'automatic', openPrsPerDonor: 5 });
    const owner = github.state.accounts['sample-owner'];
    if (!owner) throw new Error('no sample-owner');
    owner.oauthAppRestrictions = { approved: [] };
    const [first, second] = [await tagged(), await tagged()];
    // lena has no fork of the repo, and can push to none of sample-owner's.
    const lena = await donor('lena');
    const one = await claim(lena, first);
    const two = await claim(lena, second);

    const submits: Result[] = [];
    for (const [claimId, file] of [[one, 'a.txt'], [two, 'b.txt']] as const) {
      submits.push(await call(lena, 'submit_work', { claimId, branch: await push(lena, claimId, { [file]: `${file}\n` }), ...NOTES }));
    }
    const [toOne, toTwo] = submits.map((s) => s.structuredContent?.toOpen as ToOpen);
    if (!toOne || !toTwo) throw new Error('the work was not cleared');
    // The organization refuses a write from the site's OAuth app: the
    // agent's own token can't open the PR.
    const agentToken = Object.entries(github.state.tokens).find(([, grant]) => grant.login === 'lena' && grant.clientId === OAUTH_APP.clientId)?.[0] ?? '';
    const refused = await asOwnTools(agentToken, 'POST', `/repos/${APP}/pulls`, { title: toOne.title, body: toOne.body, head: toOne.head, base: toOne.base });
    // The donor's own token opens it on the compare page.
    const onePr = await openOnComparePage('lena', toOne);
    const recorded = await call(lena, 'record_pr', { claimId: one, pr: onePr });
    const twoPr = await openOnComparePage('lena', toTwo);
    const run = await runJob();

    expect(submits.map((s) => s.structuredContent?.reviewReason)).toEqual(['ready_to_open', 'ready_to_open']);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('OAuth App access restrictions');
    expect(recorded.structuredContent).toMatchObject({ state: 'pr_opened', pr: { url: onePr } });
    expect(run).toMatchObject({ recorded: 1, stopped: null });
    expect(await getPr(env.DB, two)).toMatchObject({ pr: { url: twoPr }, state: 'open' });
    expect((await issueRoom(env.ISSUE_ROOM, second).snapshot()).claims[0]).toMatchObject({ state: 'pr_opened', pr: { url: twoPr } });
    expect(await getSubmission(env.DB, two)).toMatchObject({ repo: 'lena/sample-app', source: 'branch' });
    // The server made no write, and GitHub refused it none.
    const made = serverCalls();
    expect(made.filter(isWrite)).toEqual([]);
    expect(made.filter((c) => c.status === 403)).toEqual([]);
  });
});
