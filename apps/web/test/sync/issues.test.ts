import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addPr,
  addToDoNotList,
  changeSettings,
  createProject,
  getIssue,
  getIssueSync,
  getPr,
  getProject,
  holdProject,
  listIssues,
  listProjectsAskingForHelp,
  setProjectStatus,
  statusHistory,
} from '../../src/db';
import { issueRoom, type IssueRoom } from '../../src/rooms/issue-room';
import { ServiceGitHub } from '../../src/sync/github';
import { HOLD_MS, syncTaggedIssues } from '../../src/sync/issues';
import { followPrs } from '../../src/sync/prs';
import { ALLOWANCES } from '../../src/sync/scheduled';
import { startGitHub } from '../auth/helpers';
import { db, emptyDatabase, maintainer, priya, registeredProject, sha, signIn } from '../db/helpers';
import { callsTo, freshNumbers, jobDeps, SERVICE_LOGIN, TIMELINE } from './helpers';

// The tagged-issue sync, against the GitHub fake's sample repos, with the
// issue rooms and D1 as they run deployed. sample-maintainer is an admin of
// the sample-owner repos, and priya can't push to them, so her PRs come
// from her fork. Every project and issue here is made up.

const APP = 'sample-owner/sample-app';
const DESKTOP = 'sample-owner/sample-desktop';
const TOOLS = 'sample-owner/sample-tools';
const BUNDLER = 'sample-owner/sample-bundler';
// Names sample-app and sample-desktop had before a rename.
const OLD_APP = 'sample-owner/old-app';
const OLD_DESKTOP = 'sample-owner/old-desktop';
const BY = 'sample-maintainer';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Far ahead of the real clock, so no alarm a room sets fires on its own.
const start = Date.UTC(2100, 3, 1, 12, 0, 0);

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(maintainer, priya);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  // Each run logs a line, and each pause or stop a warning.
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

/** Moves the clock on, as the time between two scheduled runs does. */
function later(ms = 15 * MINUTE): void {
  vi.setSystemTime(Date.now() + ms);
}

function sync(deps: Partial<ReturnType<typeof jobDeps>> = {}) {
  return syncTaggedIssues({ ...jobDeps(github), ...deps });
}

/** Opens an issue in sample-app as its maintainer, with the labels given. */
function tagged(title: string, labels = ['help wanted']): number {
  return github.openIssue(APP, { title, labels, by: BY });
}

const ref = (n: number, repo = APP) => `${repo}#${String(n)}`;
const room = (n: number) => issueRoom(env.ISSUE_ROOM, ref(n));

async function cached(project = APP): Promise<string[]> {
  return (await listIssues(db, project)).map((issue) => issue.issue);
}

function claim(n: number) {
  return room(n).claim({
    issue: ref(n),
    project: APP,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    slots: 3,
  });
}

/**
 * priya claims the issue, submits, and opens a PR from her fork with the
 * body given, the way the MCP tools will. The room and the prs table both
 * record it.
 */
async function claimWithPr(n: number, body: string) {
  const number = github.openPullRequest(APP, { title: 'Claimed work', body, by: 'priya' });
  const pr = { repo: APP, number, url: `${github.webUrl}/${APP}/pull/${String(number)}` };
  const claimed = await claim(n);
  if (!claimed.ok) throw new Error(claimed.refusal.message);
  const submitted = await room(n).submit({ claimId: claimed.claim.id, githubId: priya.githubId });
  if (!submitted.ok) throw new Error(submitted.refusal.message);
  const opened = await room(n).openPr({ claimId: claimed.claim.id, githubId: priya.githubId, pr });
  if (!opened.ok) throw new Error(opened.refusal.message);
  await addPr(db, { claimId: claimed.claim.id, pr, openedAt: Date.now() });
  return { claimId: claimed.claim.id, pr };
}

/**
 * Has the fake answer for a repo renamed from `from` to `to`, which it can't
 * do itself. GitHub redirects a REST call to a renamed repo's old name, and
 * fetch follows the redirect, so the answer comes from the new name, with
 * the new name in it. Here a GraphQL query finds the repo by its old name
 * too.
 */
function renamed(from: string, to: string): void {
  const [fromOwner, fromName] = from.split('/');
  const [toOwner, toName] = to.split('/');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const old = `/repos/${from}`;
    if (url.pathname === old || url.pathname.startsWith(`${old}/`)) {
      url.pathname = `/repos/${to}${url.pathname.slice(old.length)}`;
      return github.fetch(new Request(url, { method: request.method, headers: request.headers }));
    }
    if (url.pathname.endsWith('/graphql')) {
      const body = await request.json<{ variables?: Record<string, unknown> }>();
      const vars = body.variables ?? {};
      if (vars.owner === fromOwner && vars.name === fromName) body.variables = { ...vars, owner: toOwner, name: toName };
      return github.fetch(new Request(url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }));
    }
    return github.fetch(request);
  });
}

/** How many of the project's issues the homepage counts waiting for an agent. */
async function waiting(project = APP): Promise<number | undefined> {
  return (await listProjectsAskingForHelp(db, 5, Date.now())).projects.find((row) => row.project.repo === project)
    ?.waiting;
}

describe('reading tagged issues', () => {
  test('a new tagged issue shows in the cache after the next sync, read with the service token alone', async () => {
    await registeredProject();
    await sync();
    const before = await cached();
    const added = tagged('Keep the hash in rewrites', ['help wanted', 'bug']);

    later();
    await sync();

    expect(before).toEqual([ref(311)]);
    expect(await cached()).toEqual([ref(311), ref(added)]);
    expect(await getIssue(db, APP, ref(added))).toMatchObject({
      title: 'Keep the hash in rewrites',
      labels: ['help wanted', 'bug'],
      linkedPr: null,
      syncedAt: Date.now(),
    });
    expect(github.calls.length).toBeGreaterThan(0);
    expect(github.calls.filter((call) => call.login !== SERVICE_LOGIN)).toEqual([]);
  });

  test('an issue with an excluded tag is left out, and leaves the cache once it gets one', async () => {
    await registeredProject({ tags: ['help wanted'], excludedTags: ['good first issue'] });
    const kept = tagged('Log the rewrite rules');
    const excluded = tagged('Rename the rewrite option', ['help wanted', 'good first issue']);

    await sync();
    const before = await cached();
    github.labelIssue(APP, kept, 'Good First Issue', BY);
    later();
    await sync();

    expect(before).toContain(ref(kept));
    expect(before).not.toContain(ref(excluded));
    expect(await cached()).not.toContain(ref(kept));
    expect(await cached()).toContain(ref(311));
  });

  test('an assigned issue is left out, and so is a pull request that carries a tag', async () => {
    await registeredProject();
    const assigned = tagged('Cache the rewrite table');
    github.assignIssue(APP, assigned, 'priya', BY);
    const pull = github.openPullRequest(APP, { title: 'Tidy the rewrites', body: 'No issue.', by: BY });
    github.labelIssue(APP, pull, 'help wanted', BY);

    await sync();

    expect(await cached()).toEqual([ref(311)]);
  });

  test('an issue with two of the tags is read once, from the issue repo the project names', async () => {
    freshNumbers(github, DESKTOP);
    await registeredProject({ tags: ['ready', 'help wanted'], issueRepo: DESKTOP });
    const both = github.openIssue(DESKTOP, { title: 'Wake the second screen', labels: ['ready', 'help wanted'], by: BY });

    await sync();

    expect(await cached()).toEqual([ref(1431, DESKTOP), ref(1440, DESKTOP), ref(both, DESKTOP)]);
    expect(callsTo(github, TIMELINE)).toHaveLength(3);
  });

  test('a paused, pending, or do-not-listed project is not read', async () => {
    await registeredProject({ tags: ['help wanted'] });
    await setProjectStatus(db, APP, { status: 'paused', reason: null, changedBy: maintainer.githubId }, Date.now());
    await createProject(
      db,
      { repo: TOOLS, status: 'pending', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      Date.now(),
    );
    await registeredProject({ tags: ['contribution welcome'] }, BUNDLER);
    await addToDoNotList(db, { repo: BUNDLER, reason: null, addedBy: maintainer.githubId }, Date.now());

    const run = await sync();

    expect(run.projects).toBe(0);
    expect(github.calls).toEqual([]);
  });
});

describe('linked PRs', () => {
  test('a PR that closes the issue closes it to new claims, in the cache and in its room', async () => {
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    const pull = github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });

    await sync();

    const copy = await getIssue(db, APP, ref(issue));
    expect(copy?.linkedPr).toMatchObject({ repo: APP, number: pull });
    expect(copy?.linkedPrFoundBy).toEqual(['closing_reference', 'cross_reference']);
    expect(await waiting()).toBe(1);
    expect((await room(issue).snapshot()).prs.map((pr) => pr.number)).toEqual([pull]);
    expect(await claim(issue)).toMatchObject({ ok: false, refusal: { code: 'pr_exists' } });
  });

  test('a PR that only mentions the issue links it by its cross-reference', async () => {
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    const pull = github.openPullRequest(APP, { title: 'Rewrite notes', body: `Background in #${String(issue)}.`, by: 'priya' });

    await sync();

    expect(await getIssue(db, APP, ref(issue))).toMatchObject({
      linkedPr: { number: pull },
      linkedPrFoundBy: ['cross_reference'],
    });
  });

  test('a mention from another issue links nothing', async () => {
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    github.openIssue(APP, { title: 'Same as the hash one', body: `Like #${String(issue)}.`, by: 'priya' });

    await sync();

    expect(await getIssue(db, APP, ref(issue))).toMatchObject({ linkedPr: null });
  });

  test('a PR closed without merging makes the issue take claims again', async () => {
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    const pull = github.openPullRequest(APP, { title: 'Keep the hash', body: `Fixes #${String(issue)}`, by: 'priya' });
    await sync();
    const closedToClaims = await waiting();

    github.closePullRequest(APP, pull, BY);
    later();
    await sync();

    expect(closedToClaims).toBe(1);
    const copy = await getIssue(db, APP, ref(issue));
    expect(copy?.linkedPr).toBeNull();
    expect(copy?.linkedPrFoundBy).toBeUndefined();
    expect(await waiting()).toBe(2);
    expect((await room(issue).snapshot()).prs).toEqual([]);
    expect(await claim(issue)).toMatchObject({ ok: true, created: true });
  });

  test('a merged PR closes the issue, which leaves the cache, and its room forgets the PR', async () => {
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    const pull = github.openPullRequest(APP, { title: 'Keep the hash', body: `Resolves #${String(issue)}`, by: 'priya' });
    await sync();

    github.mergePullRequest(APP, pull, BY);
    later();
    await sync();

    expect(await cached()).toEqual([ref(311)]);
    expect((await room(issue).snapshot()).prs).toEqual([]);
  });

  test('when the kept PR closes, another linked PR takes its place, and the room always has one', async () => {
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    const closing = github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });
    const mention = github.openPullRequest(APP, { title: 'Hash notes', body: `See #${String(issue)}`, by: BY });
    await sync();
    const first = (await getIssue(db, APP, ref(issue)))?.linkedPr?.number;

    github.closePullRequest(APP, closing, BY);
    later();
    await sync();

    expect(first).toBe(closing);
    expect((await getIssue(db, APP, ref(issue)))?.linkedPr?.number).toBe(mention);
    expect((await room(issue).snapshot()).prs.map((pr) => pr.number)).toEqual([mention]);
  });

  test("when an issue leaves the cache, its room forgets the linked PR, unless another project's copy keeps it", async () => {
    await registeredProject();
    await registeredProject({ tags: ['help wanted'], issueRepo: APP }, TOOLS);
    const issue = tagged('Keep the hash in rewrites');
    const pull = github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });
    await sync();

    await changeSettings(db, APP, { tags: ['bug'] }, maintainer.githubId, Date.now());
    later();
    await sync();
    const oneLeft = (await room(issue).snapshot()).prs.map((pr) => pr.number);
    await changeSettings(db, TOOLS, { tags: ['bug'] }, maintainer.githubId, Date.now());
    later();
    await sync();

    expect(oneLeft).toEqual([pull]);
    expect(await cached(APP)).toEqual([]);
    expect(await cached(TOOLS)).toEqual([]);
    expect((await room(issue).snapshot()).prs).toEqual([]);
  });

  test("a claim's PR that mentions a second tagged issue leaves that issue's room once it closes, so the issue takes claims again", async () => {
    await registeredProject();
    const x = tagged('Keep the hash in rewrites');
    const y = tagged('Keep the query in rewrites');
    const { claimId, pr } = await claimWithPr(x, `Closes #${String(x)}. Related to #${String(y)}.`);
    await sync();
    const heldByY = (await room(y).snapshot()).prs.map((held) => held.number);

    github.closePullRequest(APP, pr.number, BY);
    later();
    await sync();
    await followPrs(jobDeps(github, ALLOWANCES.prs));
    later();
    await sync();

    expect(heldByY).toEqual([pr.number]);
    expect(await getPr(db, claimId)).toMatchObject({ state: 'closed' });
    expect((await getIssue(db, APP, ref(y)))?.linkedPr).toBeNull();
    expect((await room(y).snapshot()).prs).toEqual([]);
    expect((await room(x).snapshot()).prs).toEqual([]);
    expect(await claim(y)).toMatchObject({ ok: true, created: true });
  });

  test("when a second issue a claim's open PR mentions leaves the cache, that issue's room forgets the PR, and the claim's own room keeps it", async () => {
    await registeredProject();
    const x = tagged('Keep the hash in rewrites');
    const y = tagged('Keep the query in rewrites');
    const { pr } = await claimWithPr(x, `Closes #${String(x)}. Related to #${String(y)}.`);
    await sync();
    const heldByY = (await room(y).snapshot()).prs.map((held) => held.number);

    // A maintainer takes the tag off.
    const untagged = github.state.repos[APP]?.issues[String(y)];
    if (untagged) untagged.labels = [];
    later();
    await sync();

    expect(heldByY).toEqual([pr.number]);
    expect(await cached()).not.toContain(ref(y));
    expect((await room(y).snapshot()).prs).toEqual([]);
    expect((await room(x).snapshot()).prs.map((held) => held.number)).toEqual([pr.number]);
  });

  test("only a PR in the project's own repo links an issue, and a PR from a fork aimed there counts", async () => {
    freshNumbers(github, TOOLS);
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    github.openPullRequest(TOOLS, { title: 'Work around the hash', body: `Works around ${APP}#${String(issue)}.`, by: BY });
    github.openPullRequest(TOOLS, { title: 'Fix the hash upstream', body: `Closes ${APP}#${String(issue)}`, by: BY });
    await sync();
    const elsewhere = await getIssue(db, APP, ref(issue));

    const fromFork = github.openPullRequest(APP, { title: 'Keep the hash', body: `See #${String(issue)}.`, by: 'priya' });
    later();
    const run = await sync();

    expect(elsewhere?.linkedPr).toBeNull();
    expect(github.state.repos['priya/sample-app']?.forkOf).toBe(APP);
    expect((await getIssue(db, APP, ref(issue)))?.linkedPr).toMatchObject({ repo: APP, number: fromFork });
    expect(run.linked.elsewhere).toBe(2);
  });

  test("a PR in the project's issue repo links its issue, and so does one in its code repo", async () => {
    freshNumbers(github, DESKTOP);
    await registeredProject({ tags: ['ready'], issueRepo: DESKTOP });
    const first = github.openIssue(DESKTOP, { title: 'Wake the second screen', labels: ['ready'], by: BY });
    const second = github.openIssue(DESKTOP, { title: 'Keep the layout', labels: ['ready'], by: BY });
    const inIssueRepo = github.openPullRequest(DESKTOP, { title: 'Wake it', body: `Fixes #${String(first)}`, by: BY });
    const inCodeRepo = github.openPullRequest(APP, { title: 'Keep it', body: `Fixes ${DESKTOP}#${String(second)}`, by: BY });

    await sync();

    expect((await getIssue(db, APP, ref(first, DESKTOP)))?.linkedPr).toMatchObject({ repo: DESKTOP, number: inIssueRepo });
    expect((await getIssue(db, APP, ref(second, DESKTOP)))?.linkedPr).toMatchObject({ repo: APP, number: inCodeRepo });
  });

  test("after the project's repo is renamed on GitHub, a PR there still closes an issue to claims", async () => {
    await registeredProject({ tags: ['help wanted'] }, OLD_APP);
    renamed(OLD_APP, APP);
    const issue = tagged('Keep the hash in rewrites');
    const pull = github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });

    const run = await sync();
    const claimed = await issueRoom(env.ISSUE_ROOM, ref(issue, OLD_APP)).claim({
      issue: ref(issue, OLD_APP),
      project: OLD_APP,
      githubId: priya.githubId,
      login: priya.login,
      agent: 'claude-code',
      ownProject: false,
      startCommit: sha,
      slots: 3,
    });

    expect((await getProject(db, OLD_APP))?.status).toBe('approved');
    expect((await getIssue(db, OLD_APP, ref(issue, OLD_APP)))?.linkedPr).toMatchObject({ repo: APP, number: pull });
    expect(run.linked.elsewhere).toBe(0);
    expect(claimed.ok ? 'claimed' : claimed.refusal.code).toBe('pr_exists');
  });

  test("after the project's issue repo is renamed on GitHub, a PR there still links its issue", async () => {
    freshNumbers(github, DESKTOP);
    await registeredProject({ tags: ['ready'], issueRepo: OLD_DESKTOP });
    renamed(OLD_DESKTOP, DESKTOP);
    const issue = github.openIssue(DESKTOP, { title: 'Wake the second screen', labels: ['ready'], by: BY });
    const pull = github.openPullRequest(DESKTOP, { title: 'Wake it', body: `Fixes #${String(issue)}`, by: BY });

    const run = await sync();

    expect((await getIssue(db, APP, ref(issue, OLD_DESKTOP)))?.linkedPr).toMatchObject({ repo: DESKTOP, number: pull });
    expect(run.linked.elsewhere).toBe(0);
  });

  test('the run counts every linked PR by the ways it was found, whichever one each copy keeps', async () => {
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });
    github.openPullRequest(APP, { title: 'Hash notes', body: `See #${String(issue)}.`, by: BY });

    const run = await sync();

    expect(run.linked).toEqual({ closing: 0, cross: 1, both: 1, elsewhere: 0 });
  });

  test("when the room doesn't take the linked PR, the cache keeps what the room has, and the next pass tries again", async () => {
    await registeredProject();
    const issue = tagged('Keep the hash in rewrites');
    const pull = github.openPullRequest(APP, { title: 'Keep the hash', body: `Closes #${String(issue)}`, by: 'priya' });
    const down = {
      getByName: () => ({ prOpened: () => Promise.reject(new Error('The room is down.')) }),
    } as unknown as DurableObjectNamespace<IssueRoom>;

    await sync({ rooms: down });
    const unheard = await getIssue(db, APP, ref(issue));
    later();
    await sync();

    expect(unheard?.linkedPr).toBeNull();
    expect((await getIssue(db, APP, ref(issue)))?.linkedPr?.number).toBe(pull);
    expect((await room(issue).snapshot()).prs.map((pr) => pr.number)).toEqual([pull]);
  });
});

describe('delisting', () => {
  test('a repo that went private pauses its project for Good First Token, so only an admin can resume it', async () => {
    await registeredProject();
    const repo = github.state.repos[APP];
    if (repo) repo.private = true;

    const run = await sync();

    expect(run.paused).toEqual([APP]);
    expect(await getProject(db, APP)).toMatchObject({
      status: 'paused',
      statusReason: `GitHub shows no public repo named ${APP}. It went private or was deleted.`,
      statusChangedBy: null,
    });
    expect((await statusHistory(db, APP))[0]).toMatchObject({ status: 'paused', changedBy: null });
  });

  test('an archived repo, a deleted one, and an issue repo that went private each pause their project', async () => {
    await registeredProject();
    await registeredProject({ tags: ['help wanted'] }, TOOLS);
    await registeredProject({ tags: ['ready'], issueRepo: DESKTOP }, BUNDLER);
    const app = github.state.repos[APP];
    const desktop = github.state.repos[DESKTOP];
    if (app) app.archived = true;
    Reflect.deleteProperty(github.state.repos, TOOLS);
    if (desktop) desktop.private = true;

    await sync();

    expect((await getProject(db, APP))?.statusReason).toBe(`${APP} is archived on GitHub.`);
    expect((await getProject(db, TOOLS))?.statusReason).toBe(
      `GitHub shows no public repo named ${TOOLS}. It went private or was deleted.`,
    );
    expect(await getProject(db, BUNDLER)).toMatchObject({
      status: 'paused',
      statusReason: `GitHub shows no public repo named ${DESKTOP}. It went private or was deleted.`,
    });
  });

  test('a spent budget pauses nothing: the run asks GitHub what is left, and stops before its first read', async () => {
    await registeredProject();
    github.spendRateLimit(SERVICE_LOGIN, 'core', 5000);

    const run = await sync();

    expect(run.stopped).toBe('budget');
    expect(github.calls.map((call) => call.operation)).toEqual(['GET /rate_limit']);
    expect(await getProject(db, APP)).toMatchObject({ status: 'approved' });
  });

  test('a service token GitHub refuses pauses nothing, and the run stops', async () => {
    await registeredProject();

    const run = await syncTaggedIssues({ ...jobDeps(github), github: new ServiceGitHub('revoked', { leave: 0, maxCalls: 10 }) });

    expect(run.stopped).toBe('bad_token');
    expect(await getProject(db, APP)).toMatchObject({ status: 'approved' });
  });
});

describe('the budget', () => {
  test('a run stops when the budget runs low, and the next run picks up where it stopped', async () => {
    await registeredProject();
    for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) tagged(title);
    // Six tagged issues, with #311. 1,005 calls left of 5,000. The sync
    // leaves a fifth, 1,000, for other jobs, so after the repo, the list, and
    // four timelines, it stops.
    github.spendRateLimit(SERVICE_LOGIN, 'core', 3995);

    const first = await sync();
    const readFirst = callsTo(github, TIMELINE).map((call) => call.url);
    const midway = await getIssueSync(db, APP);
    const cachedMidway = await cached();
    later(HOUR);
    const second = await sync();
    const readSecond = callsTo(github, TIMELINE).slice(readFirst.length).map((call) => call.url);

    expect(first.stopped).toBe('budget');
    expect(readFirst).toHaveLength(4);
    expect(cachedMidway).toHaveLength(4);
    expect(midway).toMatchObject({ passStartedAt: start, readAt: null });
    expect(second.stopped).toBeNull();
    // The second run reads only the two issues the first didn't.
    expect(readSecond).toHaveLength(2);
    expect(readSecond.some((url) => readFirst.includes(url))).toBe(false);
    expect(await cached()).toHaveLength(6);
    expect(await getIssueSync(db, APP)).toMatchObject({ passStartedAt: null, readAt: Date.now() });
  });

  test('a run stops after as many calls as one run makes', async () => {
    await registeredProject();
    const deps = jobDeps(github, { leave: 0, maxCalls: 2 });

    const run = await syncTaggedIssues(deps);

    expect(run.stopped).toBe('calls');
    expect(github.calls).toHaveLength(2);
  });

  test("a project another run holds is left, and the run's log line names it", async () => {
    await registeredProject();
    tagged('Keep the hash in rewrites');
    await holdProject(db, APP, Date.now(), Date.now() + HOLD_MS);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const run = await sync();
    const line = log.mock.calls
      .map((parts) => parts.map(String).join(' '))
      .find((logged) => logged.startsWith('The tagged-issue sync'));

    expect(run.held).toEqual([APP]);
    expect(await cached()).toEqual([]);
    expect(line).toContain(`another run: ${APP}`);
  });
});
