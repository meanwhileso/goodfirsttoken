import {
  CLAIM_LIFETIME_MS,
  newClaim,
  nextClaimState,
  type ClaimEvent,
  type ClaimRecord,
  type FeedEvent,
  type Policy,
  type PrRef,
  type ProjectSettingsInput,
  REVIEW_WINDOW_MS,
} from '@goodfirsttoken/core';
import { repos as fakeRepos } from '@goodfirsttoken/github-fake/sample-data';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addPr,
  addToDoNotList,
  blockDonor,
  changeSettings,
  createProject,
  listProjectsAskingForHelp,
  saveClaim,
  saveIssues,
  setPrState,
  setProjectStatus,
} from '../../src/db';
import { SAMPLE_PROJECTS } from '../../src/dev/sample-work';
import { filterProjects } from '../../src/project/list';
import { loadProject, loadProjectsList, type ProjectPage, type ProjectPageResult } from '../../src/project/load';
import { issueRoom } from '../../src/rooms/issue-room';
import { repoFeed } from '../../src/rooms/feed';
import {
  admin,
  db,
  emptyDatabase,
  HOUR,
  kenji,
  maintainer,
  MINUTE,
  priya,
  registeredProject,
  repo,
  sha,
  signIn,
  t0,
} from '../db/helpers';

// The projects list and a project's page: what they load from the database
// and the project's feed, and the pages themselves through the Worker.
// Every person, repo, policy, and line here is made up.

const sam = { githubId: 1003, login: 'sam' };
type Person = typeof priya;

const request = new Request('https://primary.example/');
// The page's time for the tests that load it directly. Claims made at t0
// still hold their slots then.
const now = t0 + HOUR;

const POLICY: Policy = {
  quote: 'Agent pull requests are welcome on issues labeled help wanted.',
  url: 'https://github.com/sample-owner/sample-listed/blob/main/CONTRIBUTING.md#ai',
  tier: 'invites_agents',
};

let restore: () => void = () => undefined;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, sam, admin, maintainer);
});

afterEach(() => {
  restore();
  restore = () => undefined;
  vi.restoreAllMocks();
});

/** A project an admin listed from its policy, approved unless `status` says otherwise. */
async function policyListing(name: string, settings: ProjectSettingsInput = { tags: ['help wanted'] }) {
  const made = await createProject(
    db,
    { repo: name, status: 'approved', source: 'policy', policy: POLICY, settings, addedBy: admin.githubId },
    t0,
  );
  if (made === null) throw new Error(`${name} is already a project`);
  return made;
}

/** Caches an issue for a project, as the sync would, with these labels. */
async function tag(project: string, issue: string, labels = ['help wanted'], linkedPr: PrRef | null = null) {
  await saveIssues(db, [{ issue, project, title: `Issue ${issue}`, labels, linkedPr, syncedAt: t0 }]);
}

let claims = 0;

/** A claim on `issue` in `project`, stored in the claims mirror, after each event in turn. */
async function claim(
  issue: string,
  person: Person,
  { project = repo, at = t0, events = [], ownProject = false, agent = 'claude-code' }:
    { project?: string; at?: number; events?: [ClaimEvent, number][]; ownProject?: boolean; agent?: string } = {},
): Promise<ClaimRecord> {
  claims += 1;
  let record: ClaimRecord = {
    id: `c_project${String(claims).padStart(6, '0')}`,
    issue,
    project,
    githubId: person.githubId,
    login: person.login,
    agent,
    ownProject,
    startCommit: sha,
    tokenEstimate: null,
    ...newClaim(at),
  };
  for (const [event, time] of events) {
    const result = nextClaimState(record, event, time);
    if (!result.ok) throw new Error(result.refusal.message);
    record = result.claim;
  }
  await saveClaim(db, record, 1);
  return record;
}

function prRef(project: string, number: number): PrRef {
  return { repo: project, number, url: `https://github.com/${project}/pull/${String(number)}` };
}

/** A claim whose PR opened, recorded open in the PRs table. */
async function openedPr(issue: string, person: Person, number: number, options: { project?: string; at?: number; ownProject?: boolean; agent?: string } = {}) {
  const project = options.project ?? repo;
  const at = options.at ?? t0;
  const pr = prRef(project, number);
  const made = await claim(issue, person, {
    ...options,
    project,
    at,
    events: [
      [{ kind: 'submit' }, at + MINUTE],
      [{ kind: 'open_pr', pr }, at + 2 * MINUTE],
    ],
  });
  await addPr(db, { claimId: made.id, pr, openedAt: at + 2 * MINUTE });
  return made;
}

/** A claim whose PR merged at `mergedAt`. */
async function mergedPr(
  issue: string,
  person: Person,
  number: number,
  mergedAt: number,
  options: { project?: string; ownProject?: boolean; agent?: string } = {},
) {
  const made = await openedPr(issue, person, number, { ...options, at: mergedAt - HOUR });
  await setPrState(db, made.id, 'merged', mergedAt);
  return made;
}

function ready(result: ProjectPageResult): ProjectPage {
  if (result.state !== 'ready') throw new Error(`The page is ${result.state}.`);
  return result;
}

const load = (name = repo, at = now) => {
  const [owner = '', project = ''] = name.split('/');
  return loadProject(request, owner, project, at);
};

/**
 * A page's HTML without the empty comments React puts between two pieces of
 * text, so a test can look for the words as they read.
 */
function shown(html: string): string {
  return html.replaceAll('<!-- -->', '');
}

function databaseDown(): void {
  const vars = env as unknown as { DB: D1Database };
  const real = vars.DB;
  vars.DB = { prepare: () => { throw new Error('D1 is down.'); } } as unknown as D1Database;
  restore = () => { vars.DB = real; };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('the projects list', () => {
  test('lists every approved project off the do-not-list, the one with the most issues waiting first, with how each got in', async () => {
    await registeredProject();
    await tag(repo, `${repo}#1`);
    await policyListing('sample-owner/sample-listed');
    await tag('sample-owner/sample-listed', 'sample-owner/sample-listed#1');
    await tag('sample-owner/sample-listed', 'sample-owner/sample-listed#2');
    for (const [name, status] of [
      ['sample-owner/sample-paused', 'paused'],
      ['sample-owner/sample-pending', 'pending'],
      ['sample-owner/sample-rejected', 'rejected'],
    ] as const) {
      await registeredProject({ tags: ['help wanted'] }, name);
      await setProjectStatus(db, name, { status, reason: status === 'rejected' ? 'No tests to run.' : null, changedBy: admin.githubId }, t0);
    }
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-removed');
    await addToDoNotList(db, { repo: 'sample-owner/sample-removed', reason: null, addedBy: admin.githubId }, t0);

    const list = await loadProjectsList(now);

    expect(list).toEqual({
      state: 'ready',
      total: 2,
      projects: [
        { repo: 'sample-owner/sample-listed', tags: ['help wanted'], prMode: 'reviewed', waiting: 2, source: 'policy' },
        { repo, tags: ['help wanted'], prMode: 'reviewed', waiting: 1, source: 'registered' },
      ],
    });
  });

  test('is the page at /projects, which sets no cookie, and says so when the database is down', async () => {
    await registeredProject({ tags: ['help wanted'], prMode: 'automatic' });

    const res = await exports.default.fetch('http://localhost/projects');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html).toContain(`href="/${repo}"`);
    expect(html).toContain('registered by its maintainers');
    expect(html).toContain('<span class="badge__rule">PRs</span><span class="badge__value">automatic</span>');

    databaseDown();
    const down = await exports.default.fetch('http://localhost/projects');
    expect(down.status).toBe(503);
    expect(await down.text()).toContain('can&#x27;t be read right now');
  });
});

describe("the list's filter and search", () => {
  const projects = [
    { repo: 'Sample-Owner/Sample-Bundler', tags: ['Contribution Welcome'], prMode: 'reviewed' as const },
    { repo: 'sample-owner/sample-app', tags: ['help wanted'], prMode: 'automatic' as const },
  ];
  const repos = (found: { repo: string }[]) => found.map((project) => project.repo);

  test('the search ignores case, in the repo and in the tags, and the spaces around it', () => {
    expect(repos(filterProjects(projects, 'all', 'bundler'))).toEqual(['Sample-Owner/Sample-Bundler']);
    expect(repos(filterProjects(projects, 'all', ' SAMPLE-APP '))).toEqual(['sample-owner/sample-app']);
    expect(repos(filterProjects(projects, 'all', 'welcome'))).toEqual(['Sample-Owner/Sample-Bundler']);
    expect(repos(filterProjects(projects, 'all', 'HELP'))).toEqual(['sample-owner/sample-app']);
    expect(repos(filterProjects(projects, 'all', ''))).toEqual(repos(projects));
  });

  test('the chips keep one PR mode, and apply with the search', () => {
    expect(repos(filterProjects(projects, 'automatic PRs', ''))).toEqual(['sample-owner/sample-app']);
    expect(repos(filterProjects(projects, 'reviewed PRs', 'sample'))).toEqual(['Sample-Owner/Sample-Bundler']);
    expect(repos(filterProjects(projects, 'reviewed PRs', 'app'))).toEqual([]);
  });
});

describe('which projects have a page', () => {
  test('an approved or a paused project has one, and a pending or rejected one, or a repo that is no project, has none', async () => {
    await registeredProject();
    expect(ready(await load())).toMatchObject({ repo, status: 'approved' });

    await setProjectStatus(db, repo, { status: 'paused', reason: null, changedBy: maintainer.githubId }, t0);
    expect(ready(await load())).toMatchObject({ repo, status: 'paused' });

    await setProjectStatus(db, repo, { status: 'pending', reason: null, changedBy: maintainer.githubId }, t0);
    expect(await load()).toEqual({ state: 'not_found' });
    await setProjectStatus(db, repo, { status: 'rejected', reason: 'No tests to run.', changedBy: admin.githubId }, t0);
    expect(await load()).toEqual({ state: 'not_found' });
    expect(await load('sample-owner/sample-nothing')).toEqual({ state: 'not_found' });
  });

  test("a pause Good First Token made on its own, with no person, leaves no page, while a maintainer's or an admin's pause keeps it", async () => {
    await registeredProject();
    await tag(repo, `${repo}#1`);
    await setProjectStatus(db, repo, { status: 'paused', reason: 'Back after the release.', changedBy: maintainer.githubId }, t0);
    expect(ready(await load()).status).toBe('paused');
    await setProjectStatus(db, repo, { status: 'paused', reason: 'Too many PRs at once.', changedBy: admin.githubId }, t0 + 1);
    expect(ready(await load()).status).toBe('paused');

    // The sync pauses a project whose repo went private, was archived, or is gone.
    const delisted = `GitHub shows no public repo named ${repo}. It went private or was deleted.`;
    await setProjectStatus(db, repo, { status: 'paused', reason: delisted, changedBy: null }, t0 + 2);

    expect(await load()).toEqual({ state: 'not_found' });
    const res = await exports.default.fetch(`http://localhost/${repo}`);
    expect(res.status).toBe(404);
    // Nothing cached from the repo shows.
    expect(await res.text()).not.toContain(`Issue ${repo}#1`);
  });

  test('a project whose repo, or the repo its issues live in, is on the do-not-list has none', async () => {
    await registeredProject({ tags: ['help wanted'], issueRepo: 'sample-owner/sample-issues' });
    expect((await load()).state).toBe('ready');

    await addToDoNotList(db, { repo: 'Sample-Owner/Sample-Issues', reason: null, addedBy: admin.githubId }, t0);
    expect(await load()).toEqual({ state: 'not_found' });

    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-other');
    await addToDoNotList(db, { repo: 'sample-owner/sample-other', reason: null, addedBy: admin.githubId }, t0);
    expect(await load('sample-owner/sample-other')).toEqual({ state: 'not_found' });
  });

  test("a project on the do-not-list that keeps its issues in another project's issue repo takes no page away from that project", async () => {
    const issues = 'sample-owner/sample-issues';
    await registeredProject({ tags: ['help wanted'], issueRepo: issues });
    await registeredProject({ tags: ['help wanted'], issueRepo: issues }, 'sample-owner/sample-removed');
    await addToDoNotList(db, { repo: 'sample-owner/sample-removed', reason: null, addedBy: admin.githubId }, t0);

    expect((await load()).state).toBe('ready');
    expect(await load('sample-owner/sample-removed')).toEqual({ state: 'not_found' });
  });

  test('finds the project whatever the case of its repo in the path, and names it as it was saved', async () => {
    await registeredProject();

    expect(ready(await loadProject(request, 'Sample-Owner', 'SAMPLE-APP', now)).repo).toBe(repo);
  });

  test('a path whose owner or repo GitHub could not have, or whose owner is one of the site\'s own paths, has none', async () => {
    for (const owner of ['auth', 'mcp', 'oauth', 'dev']) {
      await registeredProject({ tags: ['help wanted'] }, `${owner}/sample-app`);
      expect(await loadProject(request, owner, 'sample-app', now), owner).toEqual({ state: 'not_found' });
    }
    expect(await loadProject(request, 'Dev', 'sample-app', now)).toEqual({ state: 'not_found' });
    expect(await loadProject(request, 'sample_owner', 'sample-app', now)).toEqual({ state: 'not_found' });
    expect(await loadProject(request, 'sample-owner', '..', now)).toEqual({ state: 'not_found' });
  });

  test("says the project can't be read when the database is down", async () => {
    databaseDown();

    expect(await load()).toEqual({ state: 'unavailable', repo });
  });
});

describe("a project's tagged issues", () => {
  test('are its cached issues that carry one of its tags and none of its excluded ones, with the slots their claims hold now', async () => {
    await registeredProject({ tags: ['help wanted'], excludedTags: ['good first issue'] });
    await tag(repo, `${repo}#3`, ['Help Wanted', 'bug']);
    await tag(repo, `${repo}#1`);
    await tag(repo, `${repo}#2`, ['bug']);
    await tag(repo, `${repo}#4`, ['help wanted', 'good first issue']);
    await claim(`${repo}#1`, priya);
    await claim(`${repo}#1`, kenji, { events: [[{ kind: 'submit' }, t0 + MINUTE]] });
    await claim(`${repo}#1`, sam, { events: [[{ kind: 'release', reason: 'stuck on the tests' }, t0 + MINUTE]] });
    // Made more than 24 hours before the page loads, so its slot is free,
    // whether or not its room has expired it yet.
    await claim(`${repo}#3`, sam, { at: now - 25 * HOUR });

    const page = ready(await load());

    expect(page.issues.total).toBe(2);
    expect(page.issues.rows.map((row) => [row.issue, row.labels, row.taken])).toEqual([
      [`${repo}#1`, ['help wanted'], 2],
      [`${repo}#3`, ['Help Wanted', 'bug'], 0],
    ]);
  });

  test('take claims exactly when the homepage counts them waiting', async () => {
    await registeredProject({ tags: ['help wanted'], claimsPerIssue: 2 });
    const issues = [1, 2, 3, 4, 5].map((n) => `${repo}#${String(n)}`);
    const [open = '', full = '', linked = '', claimPr = '', mergedAgain = ''] = issues;
    for (const issue of issues) await tag(repo, issue);
    await tag(repo, linked, ['help wanted'], prRef(repo, 70));
    await claim(open, priya);
    await claim(full, priya);
    await claim(full, kenji);
    await openedPr(claimPr, priya, 71);
    await mergedPr(mergedAgain, priya, 72, t0 + 30 * MINUTE);

    const page = ready(await load());
    const help = await listProjectsAskingForHelp(db, 5, now);

    expect(page.issues.rows.map((row) => [row.issue, row.takesClaims])).toEqual([
      [open, true],
      [full, false],
      [linked, false],
      [claimPr, false],
      [mergedAgain, true],
    ]);
    expect(help.projects[0]?.waiting).toBe(page.issues.rows.filter((row) => row.takesClaims).length);
    expect(page.issues.rows.map((row) => row.openPr)).toEqual([null, null, { repo, number: 70 }, { repo, number: 71 }, null]);
  });

  test('a claim frees its slot exactly 24 hours after it was made, or 7 days after its first submit, on the page and the homepage alike', async () => {
    await registeredProject({ tags: ['help wanted'], claimsPerIssue: 1 });
    const issues = [1, 2, 3, 4].map((n) => `${repo}#${String(n)}`);
    const [madeADayAgo = '', madeJustUnder = '', submittedAWeekAgo = '', submittedJustUnder = ''] = issues;
    for (const issue of issues) await tag(repo, issue);
    await claim(madeADayAgo, priya, { at: now - CLAIM_LIFETIME_MS });
    await claim(madeJustUnder, priya, { at: now - CLAIM_LIFETIME_MS + 1 });
    await claim(submittedAWeekAgo, kenji, {
      at: now - REVIEW_WINDOW_MS - HOUR,
      events: [[{ kind: 'submit' }, now - REVIEW_WINDOW_MS]],
    });
    await claim(submittedJustUnder, kenji, {
      at: now - REVIEW_WINDOW_MS - HOUR,
      events: [[{ kind: 'submit' }, now - REVIEW_WINDOW_MS + 1]],
    });

    const page = ready(await load());
    const help = await listProjectsAskingForHelp(db, 5, now);

    expect(page.issues.rows.map((row) => [row.issue, row.taken, row.takesClaims])).toEqual([
      [madeADayAgo, 0, true],
      [madeJustUnder, 1, false],
      [submittedAWeekAgo, 0, true],
      [submittedJustUnder, 1, false],
    ]);
    // Working now counts the same claims, with core's holdsSlot.
    expect(page.working).toBe(2);
    expect(help.projects[0]?.waiting).toBe(2);
  });

  test('of a paused project take no claims', async () => {
    await registeredProject();
    await tag(repo, `${repo}#1`);
    await setProjectStatus(db, repo, { status: 'paused', reason: null, changedBy: maintainer.githubId }, t0);

    const page = ready(await load());

    expect(page.issues.rows.map((row) => row.takesClaims)).toEqual([false]);
  });

  test('link to the issue pages in the repo where the project keeps its issues', async () => {
    await registeredProject({ tags: ['help wanted'], issueRepo: 'sample-owner/sample-issues' });
    await tag(repo, 'sample-owner/sample-issues#9');

    const page = ready(await load());

    expect(page.issues.rows.map((row) => [row.repo, row.number])).toEqual([['sample-owner/sample-issues', 9]]);
  });
});

describe('merged work and top helpers', () => {
  test("merged work is the project's claims whose PRs merged, newest first, a blocked donor's left out and own-project work kept", async () => {
    await registeredProject();
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-other');
    await mergedPr(`${repo}#1`, priya, 11, t0 + 10 * MINUTE);
    await mergedPr(`${repo}#2`, kenji, 12, t0 + 30 * MINUTE, { agent: 'codex', ownProject: true });
    await mergedPr(`${repo}#3`, sam, 13, t0 + 20 * MINUTE);
    await openedPr(`${repo}#4`, priya, 14);
    const closed = await openedPr(`${repo}#5`, priya, 15);
    await setPrState(db, closed.id, 'closed', t0 + 40 * MINUTE);
    await mergedPr('sample-owner/sample-other#1', priya, 16, t0 + 40 * MINUTE, { project: 'sample-owner/sample-other' });
    await blockDonor(db, { githubId: sam.githubId, reason: null, blockedBy: admin.githubId }, t0);

    const page = ready(await load());

    expect(page.merged.total).toBe(2);
    expect(page.merged.rows).toEqual([
      { pr: { repo, number: 12 }, issue: `${repo}#2`, login: 'kenji', agent: 'codex', mergedAt: new Date(t0 + 30 * MINUTE).toISOString() },
      { pr: { repo, number: 11 }, issue: `${repo}#1`, login: 'priya', agent: 'claude-code', mergedAt: new Date(t0 + 10 * MINUTE).toISOString() },
    ]);
  });

  test('top helpers rank people by PRs merged from their claims on the project, leaving out own-project work and blocked donors', async () => {
    await registeredProject();
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-other');
    // kenji and sam tie at two. sam reached two first.
    await mergedPr(`${repo}#1`, kenji, 11, t0 + 10 * MINUTE);
    await mergedPr(`${repo}#2`, kenji, 12, t0 + 40 * MINUTE, { agent: 'codex' });
    await mergedPr(`${repo}#3`, sam, 13, t0 + 20 * MINUTE);
    await mergedPr(`${repo}#4`, sam, 14, t0 + 30 * MINUTE, { agent: 'opencode' });
    await mergedPr(`${repo}#5`, priya, 15, t0 + 5 * MINUTE);
    // A maintainer's own-project work, and work on another project, don't count here.
    await mergedPr(`${repo}#6`, priya, 16, t0 + 6 * MINUTE, { ownProject: true });
    await mergedPr(`${repo}#7`, priya, 17, t0 + 7 * MINUTE, { ownProject: true });
    await mergedPr('sample-owner/sample-other#1', priya, 18, t0 + 8 * MINUTE, { project: 'sample-owner/sample-other' });
    const lena = { githubId: 1006, login: 'lena' };
    await signIn(lena);
    await mergedPr(`${repo}#8`, lena, 19, t0 + 9 * MINUTE);
    await mergedPr(`${repo}#9`, lena, 20, t0 + 11 * MINUTE);
    await mergedPr(`${repo}#10`, lena, 21, t0 + 12 * MINUTE);
    await blockDonor(db, { githubId: lena.githubId, reason: null, blockedBy: admin.githubId }, t0);

    const page = ready(await load());

    expect(page.helpers).toEqual([
      { login: 'sam', agent: 'opencode', score: 2 },
      { login: 'kenji', agent: 'codex', score: 2 },
      { login: 'priya', agent: 'claude-code', score: 1 },
    ]);
  });

  test('show nothing a blocked donor did and count none of it, while a working claim of theirs still counts as working', async () => {
    await registeredProject();
    await mergedPr(`${repo}#1`, kenji, 11, t0 + 10 * MINUTE);
    await claim(`${repo}#2`, kenji);
    await blockDonor(db, { githubId: kenji.githubId, reason: null, blockedBy: admin.githubId }, t0);

    const page = ready(await load());

    expect([page.merged.total, page.merged.rows, page.helpers, page.working]).toEqual([0, [], [], 1]);
    expect(JSON.stringify(page)).not.toContain('kenji');
  });
});

describe("a project's live feed", () => {
  let made = 0;
  function event(project: string, person: Person, text: string): FeedEvent {
    made += 1;
    return {
      id: `e_project${String(made).padStart(12, '0')}`,
      time: new Date(t0 + made * 1000).toISOString(),
      user: person.login,
      agent: 'claude-code',
      issue: `${project}#1`,
      claim: 'c_project_feed_0000001',
      kind: 'update',
      job: null,
      text,
    };
  }

  test("starts with the project feed's newest lines, newest first, with a blocked donor's left out", async () => {
    const name = 'sample-owner/sample-feed';
    await registeredProject({ tags: ['help wanted'] }, name);
    const lines = Array.from({ length: 8 }, (_, i) => event(name, priya, `line ${String(i)}`));
    await repoFeed(env.FEED, name).deliver([
      ...lines.map((e) => ({ event: e, githubId: priya.githubId })),
      { event: event(name, kenji, 'a line nobody should see'), githubId: kenji.githubId },
    ]);
    await blockDonor(db, { githubId: kenji.githubId, reason: null, blockedBy: admin.githubId }, t0);

    const page = ready(await load(name));

    expect(page.live?.map((e) => e.text)).toEqual(['line 7', 'line 6', 'line 5', 'line 4', 'line 3', 'line 2']);
  });
});

describe('the page, through the Worker', () => {
  const page = (path: string) => exports.default.fetch(`http://localhost${path}`);

  test('shows the issues with their slots, the rules as split badges, and who registered it and set them, and sets no cookie', async () => {
    await registeredProject({
      tags: ['help wanted'],
      excludedTags: ['good first issue'],
      prMode: 'automatic',
      whoCanClaim: 'vouched',
      disclosure: { trailer: 'Generated-by', prBody: 'Made with an agent, checked by a person.' },
      personWrittenDescription: true,
      claUrl: 'https://cla.example/sample-app',
      agentNotes: 'Run the full suite before submitting.',
      claimsPerIssue: 2,
      openPrsPerDonor: 1,
    });
    await changeSettings(db, repo, { agentNotes: 'Run just test before submitting.' }, admin.githubId, t0 + HOUR);
    await tag(repo, `${repo}#18`);
    await claim(`${repo}#18`, priya, { at: Date.now() - MINUTE });

    const res = await page(`/${repo}`);
    const html = shown(await res.text());

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html).toContain(`href="/${repo}/issues/18"`);
    expect(html).toContain('aria-label="1 of 2 taken"');
    expect(html).toContain('<span class="chip chip--live">1 working</span>');
    // A value that holds agents back is drawn on ink.
    for (const [rule, value, strict] of [
      ['PRs', 'automatic', false],
      ['claim', 'vouched', true],
      ['disclose', 'Generated-by', false],
      ['disclose', 'in the PR body', false],
      ['description', 'person writes', true],
      ['CLA', 'required', true],
      ['slots', '2', false],
      ['open PRs', '1 each', false],
      ['left to people', 'good first issue', true],
    ] as const) {
      expect(html, `${rule} | ${value}`).toContain(
        `<span class="badge${strict ? ' badge--strict' : ''}"><span class="badge__rule">${rule}</span><span class="badge__value">${value}</span></span>`,
      );
    }
    expect(html).toContain('Made with an agent, checked by a person.');
    expect(html).toContain('href="https://cla.example/sample-app"');
    expect(html).toContain('Run just test before submitting.');
    expect(html).not.toContain('Run the full suite');
    expect(html).toContain('registered by <a href="/@sample-maintainer">@sample-maintainer</a>');
    expect(html).toMatch(/set by <a href="\/@sample-admin">@sample-admin<\/a> on <time[^>]*>2026-09-26<\/time>/);
    expect(html).toContain(`curl -N primary.example/${repo}/live.txt`);
  });

  test('counts every tagged issue and merged PR in its markers and numbers, past the 100 and 10 it lists', async () => {
    await registeredProject();
    await saveIssues(
      db,
      Array.from({ length: 101 }, (_, i) => ({
        issue: `${repo}#${String(i + 1)}`,
        project: repo,
        title: `Issue ${String(i + 1)}`,
        labels: ['help wanted'],
        linkedPr: null,
        syncedAt: t0,
      })),
    );
    for (let i = 0; i < 11; i += 1) await mergedPr(`${repo}#${String(201 + i)}`, priya, 301 + i, t0 + (i + 1) * MINUTE);

    const loaded = ready(await load());
    const html = shown(await (await page(`/${repo}`)).text());

    expect([loaded.issues.total, loaded.issues.rows.length, loaded.merged.total, loaded.merged.rows.length]).toEqual([
      101, 100, 11, 10,
    ]);
    expect(html).toContain('tagged for help<span class="marker__count">101</span>');
    expect(html).toContain('merged<span class="marker__count">11</span>');
    expect(html).toContain('<b>101</b> tagged');
    expect(html).toContain('<b>11</b> merged');
    expect(html).toContain('The first 100, by number.');
  });

  test('draws reviewed PRs on ink, and the defaults that let agents act, like no CLA, plain', async () => {
    await registeredProject();

    const html = await (await page(`/${repo}`)).text();

    for (const [rule, value, strict] of [
      ['PRs', 'reviewed', true],
      ['claim', 'anyone', false],
      ['disclose', 'Assisted-by', false],
      ['disclose', 'in the PR body', false],
      ['description', 'agent may write', false],
      ['CLA', 'none', false],
      ['slots', '3', false],
      ['open PRs', '2 each', false],
    ] as const) {
      expect(html, `${rule} | ${value}`).toContain(
        `<span class="badge${strict ? ' badge--strict' : ''}"><span class="badge__rule">${rule}</span><span class="badge__value">${value}</span></span>`,
      );
    }
    expect(html).not.toContain('<span class="badge__rule">issues in</span>');
    expect(html).not.toContain('<span class="badge__rule">left to people</span>');
    expect(html).not.toContain('>CLA</dt>');
  });

  test('shows a project listed from its policy with the quote, a link to the file, and where its maintainers take it over', async () => {
    await policyListing('sample-owner/sample-listed');

    const html = shown(await (await page('/sample-owner/sample-listed')).text());

    expect(html).toContain(`“${POLICY.quote}”`);
    expect(html).toContain(`href="${POLICY.url}"`);
    expect(html).toContain('CONTRIBUTING.md#ai ↗');
    expect(html).toContain('listed from its AI policy');
    expect(html).toContain('<a href="/maintainers">take it over or remove it</a>');
    expect(html).not.toContain('registered by');
  });

  test('says a paused project is paused, and grays its slots', async () => {
    await registeredProject();
    await tag(repo, `${repo}#18`);
    await setProjectStatus(db, repo, { status: 'paused', reason: 'Back after the release.', changedBy: maintainer.githubId }, t0);

    const html = await (await page(`/${repo}`)).text();

    expect(html).toContain('Paused. Agents get no new claims here until it resumes.');
    expect(html).toContain('slots--closed');
    // The reason for a pause isn't shown.
    expect(html).not.toContain('Back after the release.');
  });

  test("answers 404 for a repo that isn't listed, and 503 when the database is down", async () => {
    const missing = await page(`/${repo}`);
    const words = await missing.text();
    expect(missing.status).toBe(404);
    expect(words).toContain('isn&#x27;t listed on Good First Token');
    // Its description claims nothing about a repo that isn't listed.
    expect(words).not.toContain('tagged issues for outside help');

    await registeredProject();
    databaseDown();
    const down = await page(`/${repo}`);
    const unread = await down.text();
    expect(down.status).toBe(503);
    expect(unread).toContain('can&#x27;t be read right now');
    expect(unread).not.toContain('tagged issues for outside help');
  });
});

describe("the site's own paths", () => {
  const page = (path: string) => exports.default.fetch(`http://localhost${path}`);

  test('an owner whose paths belong to the site has no project page and no issue page, even as a project with a claim', async () => {
    for (const owner of ['auth', 'mcp', 'oauth', 'dev']) {
      await registeredProject({ tags: ['help wanted'] }, `${owner}/sample-app`);
      const claimed = await issueRoom(env.ISSUE_ROOM, `${owner}/sample-app#1`).claim({
        issue: `${owner}/sample-app#1`,
        project: `${owner}/sample-app`,
        githubId: priya.githubId,
        login: priya.login,
        agent: 'claude-code',
        ownProject: false,
        startCommit: sha,
        slots: 3,
      });
      if (!claimed.ok) throw new Error(claimed.refusal.message);
    }

    // Sign-in answers /auth, and the MCP server /mcp, before any page.
    expect((await page('/auth/sample-app')).status).toBe(404);
    expect((await page('/mcp/sample-app')).status).toBe(401);
    expect((await page('/mcp/sample-app/issues/1')).status).toBe(401);
    for (const path of ['/oauth/sample-app', '/dev/sample-app', '/oauth/sample-app/issues/1', '/dev/sample-app/issues/1']) {
      const res = await page(path);
      const words = await res.text();
      expect(res.status, path).toBe(404);
      expect(words, path).toMatch(/There is no (project|issue) page at this address\./);
    }
  });

  test('the dev routes keep their paths from a project named like them', async () => {
    await registeredProject({ tags: ['help wanted'] }, 'dev/seed');

    // The routes exist only in development, and answer 404 elsewhere, here as staging.
    const res = await page('/dev/seed');

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found\n');
  });
});

describe('the sample work', () => {
  test("a sample project listed from its policy quotes the fake repo's own file", () => {
    const listed = SAMPLE_PROJECTS.filter((project) => project.policy);
    expect(listed.map((project) => project.repo)).toEqual(['sample-owner/sample-bundler']);
    for (const project of listed) {
      const fake = fakeRepos.find((r) => `${r.owner}/${r.name}` === project.repo);
      const prefix = `https://github.com/${project.repo}/blob/main/`;
      expect(project.policy?.url.startsWith(prefix), project.repo).toBe(true);
      const path = project.policy?.url.slice(prefix.length) ?? '';
      expect(fake?.files[path], project.repo).toContain(project.policy?.quote);
    }
  });
});
