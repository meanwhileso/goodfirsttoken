import type { ClaimRecord, PrRef } from '@goodfirsttoken/core';
import { listDurableObjectIds } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { blockDonor, changeSettings, saveIssues, savePerson, setProjectStatus } from '../../src/db';
import { loadIssue, type IssuePage, type IssuePageResult } from '../../src/issue/load';
import { applyEvent, lanesInPlay, slotsTaken, timesClaimed, type IssueView } from '../../src/issue/view';
import { issueRoom } from '../../src/rooms/issue-room';
import { LOCAL_FAKE, runAsDevelopment, setEnv } from '../auth/helpers';
import { liveSocket } from '../feed/helpers';
import { admin, db, emptyDatabase, kenji, maintainer, priya, registeredProject, repo, sha, signIn, t0 } from '../db/helpers';

// The issue page: what it loads from the issue's room and the database, the
// page itself through the Worker, and the room's live socket the page
// follows, with the same fold the page uses. The rooms, the watchers, and D1
// run as they do deployed. Every person, repo, and line here is made up.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
// Far ahead of the real clock, so no alarm a room sets fires on its own.
const start = Date.UTC(2100, 2, 1, 12, 0, 0);

const sam = { githubId: 1003, login: 'sam' };
type Person = typeof priya;

// Each test works on its own issue, so each has its own room.
let issueNumber = 700;
let issue = '';
let number = '';

beforeEach(async () => {
  issueNumber += 1;
  number = String(issueNumber);
  issue = `${repo}#${number}`;
  await emptyDatabase();
  await signIn(priya, kenji, sam, admin, maintainer);
  await registeredProject();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function at(time: number): void {
  vi.setSystemTime(time);
}

const room = () => issueRoom(env.ISSUE_ROOM, issue);
const request = new Request('https://primary.example/');

async function claim(person: Person, agent = 'claude-code', slots = 3): Promise<ClaimRecord> {
  const result = await room().claim({
    issue,
    project: repo,
    githubId: person.githubId,
    login: person.login,
    agent,
    ownProject: false,
    startCommit: sha,
    slots,
  });
  if (!result.ok) throw new Error(result.refusal.message);
  return result.claim;
}

/** priya's claim on this test's issue number in `owner/sample-app`, an account named like one of the site's own paths. */
async function claimUnder(owner: string): Promise<void> {
  const theirs = `${owner}/sample-app#${number}`;
  const made = await issueRoom(env.ISSUE_ROOM, theirs).claim({
    issue: theirs,
    project: `${owner}/sample-app`,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    slots: 3,
  });
  if (!made.ok) throw new Error(made.refusal.message);
}

async function post(claimed: ClaimRecord, text: string, job?: string): Promise<void> {
  const result = await room().postUpdate({ claimId: claimed.id, githubId: claimed.githubId, text, job });
  if (!result.ok || !result.posted) throw new Error(`The post was not stored: ${JSON.stringify(result)}`);
}

function prRef(n: number): PrRef {
  return { repo, number: n, url: `https://github.com/${repo}/pull/${String(n)}` };
}

async function openPr(claimed: ClaimRecord, n: number): Promise<void> {
  const submitted = await room().submit({ claimId: claimed.id, githubId: claimed.githubId });
  if (!submitted.ok) throw new Error(submitted.refusal.message);
  const opened = await room().openPr({ claimId: claimed.id, githubId: claimed.githubId, pr: prRef(n) });
  if (!opened.ok) throw new Error(opened.refusal.message);
}

function ready(result: IssuePageResult): IssuePage {
  if (result.state !== 'ready') throw new Error(`The page is ${result.state}.`);
  return result;
}

const load = async (): Promise<IssuePage> => ready(await loadIssue(request, 'sample-owner', 'sample-app', number));

/** Each lane in play, as the claimant's login and their lines' texts. */
function lanes(view: IssueView): Record<string, string[]> {
  return Object.fromEntries(lanesInPlay(view).map((lane) => [lane.login, lane.lines.map((line) => line.text)]));
}

describe('the lanes', () => {
  test('there is one lane for each claimant, with their lines in the order they posted them', async () => {
    const [p, k, s] = [await claim(priya), await claim(kenji, 'codex'), await claim(sam, 'opencode')];
    await post(p, 'read AGENTS.md and CONTRIBUTING');
    await post(k, 'reproduced the black screen on the second resume');
    await post(s, 'found where plugins claim file types (src/plugins.ts)');
    at(start + 11 * SECOND);
    await post(p, 'wrote failing test: a rewrite from /docs/ keeps its slash');
    await post(k, 'tests: 212 passing', 'tests');

    const page = await load();

    expect(lanes(page.view)).toEqual({
      priya: ['read AGENTS.md and CONTRIBUTING', 'wrote failing test: a rewrite from /docs/ keeps its slash'],
      kenji: ['reproduced the black screen on the second resume', 'tests: 212 passing'],
      sam: ['found where plugins claim file types (src/plugins.ts)'],
    });
    expect(lanesInPlay(page.view).map((lane) => [lane.login, lane.agent, lane.state])).toEqual([
      ['priya', 'claude-code', 'active'],
      ['kenji', 'codex', 'active'],
      ['sam', 'opencode', 'active'],
    ]);
  });

  test("a subagent's line carries its job", async () => {
    const p = await claim(priya);
    await post(p, 'ran the unit tests: 3 failing', 'tests');

    const [line] = lanesInPlay((await load()).view)[0]?.lines ?? [];

    expect(line).toMatchObject({ job: 'tests', text: 'ran the unit tests: 3 failing' });
  });

  test('a claim with no line for 30 minutes shows as paused, and its next line shows it working again', async () => {
    const p = await claim(priya);
    await post(p, 'read AGENTS.md and CONTRIBUTING');
    // No alarm runs: loading the page applies the pause that is due.
    at(start + 30 * MINUTE);

    const paused = await load();

    expect(lanesInPlay(paused.view)[0]?.state).toBe('paused');
    expect(paused.view.timeline.map((entry) => entry.text)).toEqual(['claimed the issue', 'paused: no update for 30 minutes']);
    // A paused claim still holds its slot.
    expect(slotsTaken(paused.view)).toBe(1);

    await post(p, 'back: reproduced it');
    expect(lanesInPlay((await load()).view)[0]?.state).toBe('active');
  });

  test('a released or expired claim leaves the lanes and frees its slot, and the timeline keeps what became of it', async () => {
    const p = await claim(priya);
    const k = await claim(kenji, 'codex');
    await post(k, 'sketched a streaming encoder');
    const released = await room().release({ claimId: k.id, githubId: kenji.githubId, reason: "needs a migration I couldn't run" });
    if (!released.ok) throw new Error(released.refusal.message);
    at(start + 2 * HOUR);
    await claim(sam, 'opencode');
    at(start + 23 * HOUR);
    await post(p, 'still at it');
    // priya's claim expires with no submit in 24 hours, however recent her
    // last line. sam's, made two hours later, is paused.
    at(start + 24 * HOUR + MINUTE);

    const page = await load();

    expect(lanesInPlay(page.view).map((lane) => [lane.login, lane.state])).toEqual([['sam', 'paused']]);
    expect(page.view.lanes.map((lane) => [lane.login, lane.state])).toEqual([
      ['priya', 'expired'],
      ['kenji', 'released'],
      ['sam', 'paused'],
    ]);
    expect(slotsTaken(page.view)).toBe(1);
    expect(timesClaimed(page.view)).toBe(3);
    expect(page.view.timeline.map((entry) => `@${entry.login} ${entry.text}`)).toEqual([
      '@priya claimed the issue',
      '@kenji claimed the issue',
      "@kenji released: needs a migration I couldn't run",
      '@priya paused: no update for 30 minutes',
      '@sam claimed the issue',
      '@sam paused: no update for 30 minutes',
      '@priya expired: no submit within 24 hours',
    ]);
  });

  test("names each claimant by their login now, since a login can change hands", async () => {
    await claim(priya);
    await savePerson(db, { githubId: priya.githubId, login: 'priya-renamed' }, t0 + HOUR);

    const page = await load();

    expect(lanesInPlay(page.view).map((lane) => lane.login)).toEqual(['priya-renamed']);
    expect(page.view.timeline.map((entry) => entry.login)).toEqual(['priya-renamed']);
  });
});

describe('the slots', () => {
  test("count the claims holding a slot against the project's claims per issue", async () => {
    await changeSettings(db, repo, { claimsPerIssue: 2 }, maintainer.githubId, t0);
    await claim(priya, 'claude-code', 2);

    const one = await load();
    expect([slotsTaken(one.view), one.slots, one.takingClaims]).toEqual([1, 2, true]);

    await claim(kenji, 'codex', 2);
    const full = await load();
    expect([slotsTaken(full.view), full.slots]).toEqual([2, 2]);
  });

  test('when a PR opens, the slots close, and every lane can link it', async () => {
    const p = await claim(priya);
    await claim(kenji, 'codex');
    await openPr(p, 57);

    const page = await load();

    expect(page.view.openPrs).toEqual([prRef(57)]);
    expect(lanesInPlay(page.view).map((lane) => [lane.login, lane.state, lane.pr])).toEqual([
      ['priya', 'pr_opened', prRef(57)],
      ['kenji', 'active', null],
    ]);
    // A claim with its PR open holds no slot.
    expect(slotsTaken(page.view)).toBe(1);
  });

  test('a PR someone opened outside Good First Token closes the slots too', async () => {
    await claim(priya);
    const outside = { repo, number: 61, url: `https://github.com/${repo}/pull/61` };
    await room().prOpened(outside);

    expect((await load()).view.openPrs).toEqual([outside]);

    await room().prClosed(outside);
    expect((await load()).view.openPrs).toEqual([]);
  });

  test('a project that is not approved takes no claims', async () => {
    await claim(priya);
    await setProjectStatus(db, repo, { status: 'paused', reason: 'taking a break', changedBy: maintainer.githubId }, t0);

    expect((await load()).takingClaims).toBe(false);
  });
});

describe('blocked donors', () => {
  test('have no lane, no line, and no place in the timeline, but a claim of theirs still takes its slot', async () => {
    const p = await claim(priya);
    const k = await claim(kenji, 'codex');
    await post(p, 'read AGENTS.md and CONTRIBUTING');
    await post(k, 'a line nobody should see');
    await blockDonor(db, { githubId: kenji.githubId, reason: null, blockedBy: admin.githubId }, t0);

    const page = await load();

    expect(lanes(page.view)).toEqual({ priya: ['read AGENTS.md and CONTRIBUTING'] });
    expect(page.view.timeline.map((entry) => entry.login)).toEqual(['priya']);
    expect(JSON.stringify(page)).not.toContain('nobody should see');
    expect(JSON.stringify(page)).not.toContain('kenji');
    expect(slotsTaken(page.view)).toBe(2);
    expect(timesClaimed(page.view)).toBe(2);
  });
});

describe('which issues have a page', () => {
  test('an issue a project tagged has one before anyone claims it, with its title, labels, and every slot open', async () => {
    await saveIssues(db, [
      { issue, project: repo, title: 'Handle trailing slashes in rewrites', labels: ['help wanted'], linkedPr: null, syncedAt: t0 },
    ]);

    const page = await load();

    expect(page).toMatchObject({ issue, title: 'Handle trailing slashes in rewrites', labels: ['help wanted'], slots: 3 });
    expect([lanesInPlay(page.view), slotsTaken(page.view), timesClaimed(page.view)]).toEqual([[], 0, 0]);
  });

  test('an issue with no claim that no project tagged has none, and asking makes no room', async () => {
    const result = await loadIssue(request, 'sample-owner', 'sample-app', number);

    expect(result).toEqual({ state: 'not_found' });
    const rooms = (await listDurableObjectIds(env.ISSUE_ROOM)).map(String);
    expect(rooms).not.toContain(String(env.ISSUE_ROOM.idFromName(issue.toLowerCase())));
  });

  test('a path whose owner, repo, or number GitHub could not have, or whose owner is one of the site\'s own paths, has none', async () => {
    await claim(priya);
    // Accounts named like the site's own paths could exist on GitHub, and
    // even with a claim, their issues get no page.
    for (const owner of ['mcp', 'oauth', 'auth']) await claimUnder(owner);
    for (const [owner, name, n] of [
      ['sample-owner', 'sample-app', '0'],
      ['sample-owner', 'sample-app', `0${number}`],
      ['sample_owner', 'sample-app', number],
      ['mcp', 'sample-app', number],
      ['OAuth', 'sample-app', number],
      ['auth', 'sample-app', number],
    ] as const) {
      expect(await loadIssue(request, owner, name, n), `${owner}/${name}#${n}`).toEqual({ state: 'not_found' });
    }
  });

  test('finds the issue whatever the case of its repo in the path', async () => {
    await claim(priya);

    const page = ready(await loadIssue(request, 'Sample-Owner', 'Sample-App', number));

    expect(page.issue).toBe(issue);
    expect(lanesInPlay(page.view).map((lane) => lane.login)).toEqual(['priya']);
  });

  test("says the issue can't be read when the database is down", async () => {
    const vars = env as unknown as { DB: D1Database };
    const real = vars.DB;
    vars.DB = { prepare: () => { throw new Error('D1 is down.'); } } as unknown as D1Database;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await loadIssue(request, 'sample-owner', 'sample-app', number)).toEqual({ state: 'unavailable', issue });
    } finally {
      vars.DB = real;
    }
  });
});

describe('the page, through the Worker', () => {
  const page = (path: string) => exports.default.fetch(`http://localhost${path}`);

  test('shows the lanes, the slots, and the timeline, and sets no cookie for a visitor', async () => {
    const p = await claim(priya);
    await post(p, 'wrote failing test: a rewrite from /docs/ keeps its slash');

    const res = await page(`/${repo}/issues/${number}`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html).toContain('wrote failing test: a rewrite from /docs/ keeps its slash');
    expect(html).toContain('1 of 3 slots taken');
    expect(html).toContain(`/goodfirsttoken:work ${issue}`);
    expect(html).toContain(`curl -N primary.example/${repo}/issues/${number}/live.txt`);
  });

  test('answers 404 for an issue that is not on the site, and 503 when the database is down', async () => {
    expect((await page(`/${repo}/issues/${number}`)).status).toBe(404);

    await claim(priya);
    const vars = env as unknown as { DB: D1Database };
    const real = vars.DB;
    vars.DB = { prepare: () => { throw new Error('D1 is down.'); } } as unknown as D1Database;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await page(`/${repo}/issues/${number}`);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('can&#x27;t be read right now');
    } finally {
      vars.DB = real;
    }
  });

  test("leaves the site's own paths to the site: sign-in, the MCP server, and the OAuth routes", async () => {
    // Accounts named like the site's own paths, with a claim each.
    for (const owner of ['auth', 'mcp', 'oauth']) await claimUnder(owner);

    const auth = await page(`/auth/sample-app/issues/${number}`);
    expect(auth.status).toBe(404);
    expect(await auth.text()).not.toContain('Not on Good First Token');
    expect((await page(`/mcp/sample-app/issues/${number}`)).status).toBe(401);
    const oauth = await page(`/oauth/sample-app/issues/${number}`);
    expect(oauth.status).toBe(404);
    expect(await oauth.text()).not.toContain('slots taken');
  });
});

describe("the room's live socket, as the page follows it", () => {
  test('several claimants posting at once each reach their own lane, in the order they posted', async () => {
    const [p, k, s] = [await claim(priya), await claim(kenji, 'codex'), await claim(sam, 'opencode')];
    const loaded = await load();
    const socket = await liveSocket(`/${repo}/issues/${number}/live.ndjson?since=${String(loaded.view.last)}`);

    await Promise.all([
      post(p, 'priya 1: read AGENTS.md'),
      post(k, 'kenji 1: reading the feed Durable Object'),
      post(s, 'sam 1: reproduced it'),
    ]);
    at(start + 11 * SECOND);
    await Promise.all([post(p, 'priya 2: tests: 1 failing'), post(k, 'kenji 2: sketched an encoder', 'spike')]);
    await socket.received(5);
    socket.socket.close(1000);

    const live = socket.events.reduce((view, event) => applyEvent(view, event), loaded.view);
    expect(lanes(live)).toEqual({
      priya: ['priya 1: read AGENTS.md', 'priya 2: tests: 1 failing'],
      kenji: ['kenji 1: reading the feed Durable Object', 'kenji 2: sketched an encoder'],
      sam: ['sam 1: reproduced it'],
    });
    // The socket starts after the last event the page loaded with.
    expect(socket.events.map((event) => event.kind)).toEqual(['update', 'update', 'update', 'update', 'update']);
    // Folding in what the page loads later gives the same lanes.
    expect(lanes((await load()).view)).toEqual(lanes(live));
  });

  test('a pause, a PR, and a release reach the page as they happen: the lane shows paused, the slots close, and the lane leaves', async () => {
    const p = await claim(priya);
    const k = await claim(kenji, 'codex');
    const loaded = await load();
    const socket = await liveSocket(`/${repo}/issues/${number}/live.ndjson?since=${String(loaded.view.last)}`);

    at(start + 30 * MINUTE);
    await post(p, 'still here');
    // kenji posted nothing for 30 minutes. Any call to the room applies it.
    await socket.event('paused: no update for 30 minutes');
    let live = socket.events.reduce((view, event) => applyEvent(view, event), loaded.view);
    expect(lanesInPlay(live).map((lane) => [lane.login, lane.state])).toEqual([
      ['priya', 'active'],
      ['kenji', 'paused'],
    ]);

    await openPr(p, 57);
    await socket.event(`opened PR ${repo}#57`);
    live = socket.events.reduce((view, event) => applyEvent(view, event), loaded.view);
    expect(live.openPrs).toEqual([prRef(57)]);
    expect(lanesInPlay(live).find((lane) => lane.login === 'priya')?.pr).toEqual(prRef(57));

    const released = await room().release({ claimId: k.id, githubId: kenji.githubId, reason: 'saw PR #57, stopping' });
    if (!released.ok) throw new Error(released.refusal.message);
    await socket.event('released: saw PR #57, stopping');
    socket.socket.close(1000);
    live = socket.events.reduce((view, event) => applyEvent(view, event), loaded.view);
    expect(lanesInPlay(live).map((lane) => lane.login)).toEqual(['priya']);
    expect(live.timeline.at(-1)?.text).toBe('released: saw PR #57, stopping');
  });

  test('an event the page already has shows once', async () => {
    const p = await claim(priya);
    await post(p, 'read AGENTS.md and CONTRIBUTING');
    const loaded = await load();
    // With no since, the room sends its whole history, which the page has.
    const socket = await liveSocket(`/${repo}/issues/${number}/live.ndjson`);
    await socket.received(2);
    socket.socket.close(1000);

    const live = socket.events.reduce((view, event) => applyEvent(view, event), loaded.view);

    expect(live).toEqual(loaded.view);
  });
});

describe('the dev-only route that works an issue as a sample person', () => {
  const work = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    exports.default.fetch('http://localhost:5173/dev/work', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ issue, ...body }),
    });

  test.each(['staging', 'production'])('outside development, as in %s, does not exist and works nothing', async (environment) => {
    const restore = setEnv({ ENVIRONMENT: environment, GH_WEB_URL: LOCAL_FAKE.web, GH_API_URL: LOCAL_FAKE.api });
    try {
      expect((await work({ login: 'priya', action: 'claim' })).status).toBe(404);
    } finally {
      restore();
    }
    expect(await loadIssue(request, 'sample-owner', 'sample-app', number)).toEqual({ state: 'not_found' });
  });

  test('in development, claims, posts, submits, opens the PR, and releases through the room', async () => {
    const restore = runAsDevelopment();
    try {
      expect(await (await work({ login: 'priya', action: 'claim', agent: 'claude-code' })).json()).toMatchObject({
        ok: true,
        created: true,
      });
      expect((await work({ login: 'kenji', action: 'claim', agent: 'codex' })).status).toBe(200);
      expect(await (await work({ login: 'priya', action: 'post', text: 'read AGENTS.md', job: 'docs' })).json()).toMatchObject({
        ok: true,
        posted: true,
      });
      await work({ login: 'priya', action: 'submit' });
      expect(await (await work({ login: 'priya', action: 'open_pr', pr: 57 })).json()).toMatchObject({
        ok: true,
        claim: { state: 'pr_opened', pr: prRef(57) },
      });
      await work({ login: 'kenji', action: 'release', reason: 'saw PR #57, stopping' });
    } finally {
      restore();
    }

    const page = await load();
    expect(lanes(page.view)).toEqual({ priya: ['read AGENTS.md'] });
    expect(page.view.openPrs).toEqual([prRef(57)]);
    expect(page.view.timeline.map((entry) => `@${entry.login} ${entry.text}`)).toEqual([
      '@priya claimed the issue',
      '@kenji claimed the issue',
      '@priya submitted the work',
      `@priya opened PR ${repo}#57`,
      '@kenji released: saw PR #57, stopping',
    ]);
  });

  test('on a database with nothing in it, adds the sample project and its sample issues first', async () => {
    await emptyDatabase();
    const restore = runAsDevelopment();
    try {
      const res = await work({ login: 'priya', action: 'claim', issue: 'sample-owner/sample-desktop#1431' });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, created: true });
    } finally {
      restore();
    }

    const page = ready(await loadIssue(request, 'sample-owner', 'sample-desktop', '1431'));
    expect(page).toMatchObject({ title: 'Suspend fails on the second resume', labels: ['ready'], slots: 3, takingClaims: true });
    expect(lanesInPlay(page.view).map((lane) => lane.login)).toEqual(['priya']);
  });

  test('works only as a sample person, on an approved sample project, and only a claim they hold', async () => {
    const restore = runAsDevelopment();
    try {
      expect((await work({ login: 'nobody-here', action: 'claim' })).status).toBe(422);
      expect((await work({ login: 'priya', action: 'claim', issue: 'sample-owner/sample-harbor#88' })).status).toBe(422);
      expect((await work({ login: 'priya', action: 'claim', issue: 'someone-else/their-app#1' })).status).toBe(422);
      expect((await work({ login: 'priya', action: 'post', text: 'no claim yet' })).status).toBe(409);
      expect((await work({ login: 'priya', action: 'merge' })).status).toBe(400);
    } finally {
      restore();
    }
    expect(await loadIssue(request, 'sample-owner', 'sample-app', number)).toEqual({ state: 'not_found' });
  });

  test('refuses a POST from a page on another site', async () => {
    const restore = runAsDevelopment();
    try {
      expect((await work({ login: 'priya', action: 'claim' }, { origin: 'https://elsewhere.example' })).status).toBe(403);
    } finally {
      restore();
    }
    expect(await loadIssue(request, 'sample-owner', 'sample-app', number)).toEqual({ state: 'not_found' });
  });
});
