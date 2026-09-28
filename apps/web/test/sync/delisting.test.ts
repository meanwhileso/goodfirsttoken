import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getIssueSync, getProject, listIssues, listWaitingIssues, savePerson, setProjectStatus, statusHistory } from '../../src/db';
import { syncTaggedIssues } from '../../src/sync/issues';
import { APP as OAUTH_APP, startGitHub } from '../auth/helpers';
import { db, emptyDatabase, maintainer, registeredProject, signIn, t0 } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from '../mcp/helpers';
import { workerFetch } from '../worker';
import { callsTo, jobDeps, SERVICE_LOGIN } from './helpers';

// Delisting a project the sync reads no issues for: a paused one, whoever
// paused it, and an approved one resumed while the sync had it delisted.
// Each run first reads their repos with the service token, and a repo
// GitHub shows private, archived, blocked, or gone hides what the site
// cached from it, on the project's page, its issues' pages, and the lists.
// The people and repos are the GitHub fake's sample data: sample-maintainer
// is an admin of the sample-owner repos, and sample-admin is the site's
// admin here. Every project and reason is made up.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
// sample-maintainer's GitHub ID in the fake.
const MAINTAINER_ID = 1009;
const APP = 'sample-owner/sample-app';
const DESKTOP = 'sample-owner/sample-desktop';
const TOOLS = 'sample-owner/sample-tools';
// sample-app's tagged issue in the fake, and its title.
const ISSUE = `${APP}#311`;
const TITLE = 'Handle trailing slashes in rewrites';
const HOUR = 3_600_000;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  env.ADMIN_GITHUB_IDS = String(ADMIN.githubId);
  // These tests make more MCP calls than the limit of 120 a minute allows
  // the same few people. tools.test.ts tests the limit.
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  // Each run logs a line, and each pause or stop a warning.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(agent: ConnectedAgent, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await agent.client.callTool({ name, arguments: args })) as Result;
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text).join('\n');
}

function sampleRepo(name: string) {
  const repo = github.state.repos[name];
  if (!repo) throw new Error(`missing sample repo ${name}`);
  return repo;
}

function sync() {
  return syncTaggedIssues(jobDeps(github));
}

/** Registers the repo as sample-maintainer, with the settings given, and has the admin approve it. */
async function listed(agent: ConnectedAgent, repo = APP, settings: Record<string, unknown> = { tags: ['help wanted'] }) {
  const registered = await call(agent, 'register_project', { repo, settings });
  if (registered.structuredContent?.saved !== true) throw new Error(textOf(registered));
  await savePerson(env.DB, ADMIN, Date.now());
  await setProjectStatus(env.DB, repo, { status: 'approved', reason: null, changedBy: ADMIN.githubId }, Date.now());
}

const page = (path: string) => workerFetch(`http://localhost${path}`);

/**
 * What the site shows of a project and one of its cached issues, from the
 * pages themselves: the project page's status, the issue page's status,
 * whether the issue page shows the cached title or labels and says the
 * project takes no claims, and whether the homepage or the projects list
 * lists the project.
 */
async function shown(project = APP, issue = ISSUE, title = TITLE, label = 'help wanted') {
  const projectPage = await page(`/${project}`);
  await projectPage.body?.cancel();
  const [repo = '', number = ''] = issue.split('#');
  const issuePage = await page(`/${repo}/issues/${number}`);
  const html = await issuePage.text();
  const lists = await Promise.all(['/', '/projects'].map(async (path) => (await page(path)).text()));
  return {
    projectPage: projectPage.status,
    issuePage: issuePage.status,
    title: html.includes(title),
    labels: html.includes(`<span class="tag">${label}</span>`),
    closed: html.includes('The project isn&#x27;t taking claims right now.'),
    listed: lists.some((list) => list.includes(`href="/${project}"`)),
  };
}

/** The GitHub token the fake gave `login`'s agent when it signed in. */
function gitHubTokenOf(login: string): string {
  const found = Object.entries(github.state.tokens).find(
    ([, grant]) => grant.clientId === OAUTH_APP.clientId && grant.login === login,
  );
  if (!found) throw new Error(`${login} has no agent token`);
  return found[0];
}

describe('a project its maintainer paused', () => {
  /** sample-app listed, read once by the sync, then paused by sample-maintainer. */
  async function pausedByItsMaintainer(): Promise<ConnectedAgent> {
    const agent = await connectAgent(github, 'sample-maintainer');
    await listed(agent);
    await sync();
    const paused = await call(agent, 'pause_project', { repo: APP, reason: 'Release week.' });
    expect(paused.structuredContent).toMatchObject({ status: 'paused', changed: true, resumableBy: 'maintainers' });
    return agent;
  }

  test('has no page, and its issue page shows no cached title, once the sync finds its repo went private', async () => {
    await pausedByItsMaintainer();
    const beforeTheRepo = await shown();
    sampleRepo(APP).private = true;

    const run = await sync();

    // The page and the cached title showed while the repo was public.
    expect(beforeTheRepo).toMatchObject({ projectPage: 200, title: true, labels: true, listed: false });
    expect(run.delisted).toEqual([APP]);
    expect(await shown()).toEqual({ projectPage: 404, issuePage: 200, title: false, labels: false, closed: true, listed: false });
    // The mark sits beside the maintainer's pause, which stays theirs, and
    // adds nothing to the status history.
    expect(await getProject(env.DB, APP)).toMatchObject({
      status: 'paused',
      statusReason: 'Release week.',
      statusChangedBy: MAINTAINER_ID,
    });
    expect(await statusHistory(env.DB, APP)).toHaveLength(3);
    expect(await getIssueSync(env.DB, APP)).toMatchObject({
      delisted: `GitHub shows no public repo named ${APP}. It went private or was deleted.`,
    });
  });

  test('shows nothing cached when an admin resumes it while its repo is still private, and the next sync pauses it for Good First Token', async () => {
    const agent = await pausedByItsMaintainer();
    sampleRepo(APP).private = true;
    await sync();

    // GitHub shows the maintainer's token no public repo, so their resume is refused.
    const byMaintainer = await call(agent, 'pause_project', { repo: APP, paused: false });
    const admin = await connectAgent(github, ADMIN.login);
    const byAdmin = await call(admin, 'admin_pause_project', { repo: APP, paused: false });
    const resumed = await shown();
    const suggestions = await listWaitingIssues(env.DB, Date.now());
    const run = await sync();

    expect(textOf(byMaintainer)).toMatch(/^Refused \(not_maintainer\): GitHub shows you no public repo named/);
    expect(byAdmin.structuredContent).toMatchObject({ repo: APP, status: 'approved', changed: true });
    // Between the resume and the next sync, nothing cached shows, and no
    // one is sent to its issues.
    expect(resumed).toEqual({ projectPage: 404, issuePage: 200, title: false, labels: false, closed: true, listed: false });
    expect(suggestions).toEqual([]);
    // The next run finds the repo still private and pauses the approved project.
    expect(run.delisted).toEqual([APP]);
    expect(await getProject(env.DB, APP)).toMatchObject({ status: 'paused', statusChangedBy: null });
    expect(await shown()).toMatchObject({ projectPage: 404, title: false, labels: false });
  });

  test('shows nothing cached when its maintainer resumes it with a token GitHub shows the private repo to', async () => {
    const agent = await pausedByItsMaintainer();
    sampleRepo(APP).private = true;
    await sync();
    const grant = github.state.tokens[gitHubTokenOf('sample-maintainer')];
    if (grant) grant.scopes = ['repo'];

    const resumed = await call(agent, 'pause_project', { repo: APP, paused: false });

    expect(resumed.structuredContent).toMatchObject({ status: 'approved', changed: true });
    expect(await shown()).toEqual({ projectPage: 404, issuePage: 200, title: false, labels: false, closed: true, listed: false });
  });

  test('gets its page back once the sync sees its repo public again, with no one acting, and its pause still theirs', async () => {
    const agent = await pausedByItsMaintainer();
    sampleRepo(APP).private = true;
    await sync();
    const hidden = await shown();

    sampleRepo(APP).private = false;
    const run = await sync();
    const back = await shown();
    const project = await getProject(env.DB, APP);
    await call(agent, 'pause_project', { repo: APP, paused: false });

    expect(hidden.projectPage).toBe(404);
    expect(run).toMatchObject({ checked: 1, delisted: [] });
    expect(back).toEqual({ projectPage: 200, issuePage: 200, title: true, labels: true, closed: true, listed: false });
    expect(project).toMatchObject({ status: 'paused', statusReason: 'Release week.', statusChangedBy: MAINTAINER_ID });
    expect(await getIssueSync(env.DB, APP)).toMatchObject({ delisted: null });
    // Their resume lists it again.
    expect(await shown()).toMatchObject({ projectPage: 200, title: true, closed: false, listed: true });
  });

  test('is delisted when its issue repo, apart from its code repo, went private, and its issues there show nothing cached', async () => {
    const agent = await connectAgent(github, 'sample-maintainer');
    await listed(agent, APP, { tags: ['ready'], issueRepo: DESKTOP });
    await sync();
    await call(agent, 'pause_project', { repo: APP, reason: 'Release week.' });
    const issue = `${DESKTOP}#1431`;
    const [title, label] = ['Suspend fails on the second resume', 'ready'];
    const before = await shown(APP, issue, title, label);
    sampleRepo(DESKTOP).private = true;

    const run = await sync();

    expect(before).toMatchObject({ projectPage: 200, title: true, labels: true });
    expect(run.delisted).toEqual([APP]);
    expect(await shown(APP, issue, title, label)).toEqual({
      projectPage: 404,
      issuePage: 200,
      title: false,
      labels: false,
      closed: true,
      listed: false,
    });
    expect(await getIssueSync(env.DB, APP)).toMatchObject({
      delisted: `GitHub shows no public repo named ${DESKTOP}. It went private or was deleted.`,
    });
    // The sync read the code repo, then the issue repo.
    const bySync = callsTo(github, 'GET /repos/{owner}/{repo}').filter((c) => c.login === SERVICE_LOGIN);
    expect(bySync.slice(-2).map((c) => new URL(c.url).pathname)).toEqual([
      `/repos/${APP}`,
      `/repos/${DESKTOP}`,
    ]);
  });
});

describe('any paused project', () => {
  beforeEach(async () => {
    await signIn(maintainer, ADMIN);
  });

  async function pausedProject(repo: string, changedBy: number | null, reason = 'Release week.') {
    await registeredProject({ tags: ['help wanted'] }, repo);
    await setProjectStatus(db, repo, { status: 'paused', reason, changedBy }, t0);
  }

  test("an archived repo and a deleted one delist it too, each with its reason, and an admin's pause stays the admin's", async () => {
    await pausedProject(APP, maintainer.githubId);
    await pausedProject(TOOLS, ADMIN.githubId, 'Spam reports.');
    sampleRepo(APP).archived = true;
    Reflect.deleteProperty(github.state.repos, TOOLS);

    const run = await sync();

    expect(run.delisted).toEqual([APP, TOOLS]);
    expect(await getIssueSync(db, APP)).toMatchObject({ delisted: `${APP} is archived on GitHub.` });
    expect(await getIssueSync(db, TOOLS)).toMatchObject({
      delisted: `GitHub shows no public repo named ${TOOLS}. It went private or was deleted.`,
    });
    expect((await page(`/${APP}`)).status).toBe(404);
    expect((await page(`/${TOOLS}`)).status).toBe(404);
    expect(await getProject(db, TOOLS)).toMatchObject({ status: 'paused', statusReason: 'Spam reports.', statusChangedBy: ADMIN.githubId });
    expect(await statusHistory(db, TOOLS)).toHaveLength(2);
  });

  test("a project Good First Token paused shows as paused once the sync sees its repo public and open again, and stays the admins' to resume", async () => {
    await registeredProject();
    await sync();
    sampleRepo(APP).archived = true;
    await sync();
    const paused = await getProject(db, APP);
    const hidden = (await page(`/${APP}`)).status;

    sampleRepo(APP).archived = false;
    await sync();
    const res = await page(`/${APP}`);
    const html = await res.text();

    expect(paused).toMatchObject({ status: 'paused', statusChangedBy: null });
    expect(hidden).toBe(404);
    expect(res.status).toBe(200);
    expect(html).toContain('Paused. Agents get no new claims here until it resumes.');
    expect(html).toContain(TITLE);
    expect(await getProject(db, APP)).toMatchObject({ status: 'paused', statusChangedBy: null });
  });
});

describe('the checks and the budget', () => {
  beforeEach(async () => {
    await signIn(maintainer);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2100, 4, 1, 12, 0, 0));
  });

  /** The repos the service token read, in order, from the `from`th call on. */
  function reposRead(from = 0): string[] {
    return callsTo(github, 'GET /repos/{owner}/{repo}')
      .slice(from)
      .map((c) => new URL(c.url).pathname.replace('/repos/', ''));
  }

  async function pausedProjects(names: readonly string[]) {
    for (const name of names) {
      await registeredProject({ tags: ['help wanted'] }, name);
      await setProjectStatus(db, name, { status: 'paused', reason: null, changedBy: maintainer.githubId }, t0);
    }
  }

  test('a spent budget stops the checks, keeps what they saw, and the next run checks first the projects they left', async () => {
    await pausedProjects([APP, DESKTOP, TOOLS]);
    sampleRepo(TOOLS).private = true;
    // 1,001 calls left of 5,000. The sync leaves a fifth for other jobs, so
    // it reads two repos and stops.
    github.spendRateLimit(SERVICE_LOGIN, 'core', 3999);

    const first = await sync();
    const readFirst = reposRead();
    const midway = await getIssueSync(db, TOOLS);
    vi.setSystemTime(Date.now() + HOUR);
    const second = await sync();

    expect(first).toMatchObject({ stopped: 'budget', checked: 2 });
    expect(readFirst).toEqual([APP, DESKTOP]);
    expect(midway).toBeNull();
    expect(second).toMatchObject({ stopped: null, checked: 3, delisted: [TOOLS] });
    expect(reposRead(readFirst.length)).toEqual([TOOLS, APP, DESKTOP]);
    expect((await page(`/${TOOLS}`)).status).toBe(404);
    expect((await page(`/${APP}`)).status).toBe(200);
  });

  test("the checks leave the rest of a run's calls to the passes, and the next run checks first the projects they left", async () => {
    await registeredProject();
    // GitHub shows none of these repos, so a check reads one each.
    const gone = Array.from({ length: 250 }, (_, i) => `sample-owner/sample-gone-${String(i).padStart(3, '0')}`);
    await pausedProjects(gone);
    const allowance = { leave: 0.2, maxCalls: 200 };

    const first = await syncTaggedIssues(jobDeps(github, allowance));
    const readFirst = reposRead();
    const second = await syncTaggedIssues(jobDeps(github, allowance));
    const readSecond = reposRead(readFirst.length);

    // The approved project's pass read its issues, though the checks alone
    // could have spent the whole run.
    expect(first).toMatchObject({ stopped: null, finished: 1 });
    expect(first.checked).toBeGreaterThan(0);
    expect(first.checked).toBeLessThan(gone.length);
    expect(await listIssues(db, APP)).toMatchObject([{ issue: ISSUE }]);
    expect(readFirst.slice(0, first.checked)).toEqual(gone.slice(0, first.checked));
    // The second run starts with the next ones.
    expect(readSecond.slice(0, second.checked)).toEqual(gone.slice(first.checked, first.checked + second.checked));
  });
});
