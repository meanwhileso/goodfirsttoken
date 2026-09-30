import { newClaim, nextClaimState, type ClaimEvent, type ClaimRecord, type FeedEvent } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addPr,
  addToDoNotList,
  blockDonor,
  createProject,
  saveClaim,
  saveIssues,
  savePerson,
  setDelisted,
  setPrState,
} from '../../src/db';
import { formatRate, formatTokens } from '../../src/leaderboard/format';
import { NAMED_AGENTS, withNamedAgents } from '../../src/leaderboard/load';
import { activitySquares, activityStart, levelOf } from '../../src/person/activity';
import { loadPerson, type PersonPage, type PersonPageResult } from '../../src/person/load';
import { homeFeed, personFeed } from '../../src/rooms/feed';
import { admin, DAY, db, emptyDatabase, HOUR, kenji, maintainer, MINUTE, priya, repo, sha, signIn, t0 } from '../db/helpers';
import { workerFetch } from '../worker';

// A person's page, the leaderboard, and /live: what they load, and the pages
// themselves through the Worker. Every person, repo, title, and line here
// is made up.

const sam = { githubId: 1003, login: 'sam' };
const other = 'sample-owner/sample-desktop';
type Person = typeof priya;

const request = new Request('https://primary.example/');
// Claims made an hour before still hold their slots then.
const now = t0 + HOUR;

let restore: () => void = () => undefined;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, sam, maintainer, admin);
  for (const name of [repo, other]) {
    await createProject(
      db,
      { repo: name, status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0 - 60 * DAY,
    );
  }
});

afterEach(() => {
  restore();
  restore = () => undefined;
  vi.restoreAllMocks();
});

let made = 0;

/** A claim on `issue` in `project`, after each event in turn, and its PR's end when `ended` says. */
async function claim(
  person: Person,
  issue: number,
  {
    project = repo,
    at = t0,
    events = [],
    ended,
    ownProject = false,
  }: {
    project?: string;
    at?: number;
    events?: [ClaimEvent, number][];
    ended?: { state: 'merged' | 'closed'; at: number };
    ownProject?: boolean;
  } = {},
): Promise<ClaimRecord> {
  made += 1;
  let record: ClaimRecord = {
    id: `c_person${String(made).padStart(6, '0')}`,
    issue: `${project}#${String(issue)}`,
    project,
    githubId: person.githubId,
    login: person.login,
    agent: 'claude-code',
    ownProject,
    startCommit: sha,
    tokenEstimate: null,
    ...newClaim(at),
  };
  for (const [event, time] of events) {
    const next = nextClaimState(record, event, time);
    if (!next.ok) throw new Error(next.refusal.message);
    record = next.claim;
  }
  await saveClaim(db, record, 1);
  if (record.pr) {
    const opened = events.at(-1)?.[1] ?? at;
    await addPr(db, { claimId: record.id, pr: record.pr, openedAt: opened });
    if (ended) await setPrState(db, record.id, ended.state, ended.at);
  }
  return record;
}

/** The events that open PR `number` on `project`, from a claim made at `at`. */
function opens(project: string, number: number, at: number): [ClaimEvent, number][] {
  const pr = { repo: project, number, url: `https://github.com/${project}/pull/${String(number)}` };
  return [
    [{ kind: 'submit' }, at + MINUTE],
    [{ kind: 'open_pr', pr }, at + 2 * MINUTE],
  ];
}

async function tag(project: string, number: number, title: string) {
  await saveIssues(db, [{ issue: `${project}#${String(number)}`, project, title, labels: ['help wanted'], linkedPr: null, syncedAt: t0 }]);
}

function ready(result: PersonPageResult): PersonPage {
  if (result.state !== 'ready') throw new Error(`The page is ${result.state}.`);
  return result;
}

/** A page's HTML without the empty comments React puts between two pieces of text. */
function shown(html: string): string {
  return html.replaceAll('<!-- -->', '');
}

const page = (path: string) => workerFetch(`http://localhost${path}`);

function databaseDown(): void {
  const vars = env as unknown as { DB: D1Database };
  const real = vars.DB;
  vars.DB = { prepare: () => { throw new Error('D1 is down.'); } } as unknown as D1Database;
  restore = () => { vars.DB = real; };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

let events = 0;
function event(person: Person, text: string, project = repo): FeedEvent {
  events += 1;
  return {
    id: `e_person${String(events).padStart(12, '0')}`,
    time: new Date(t0 + events * 1000).toISOString(),
    user: person.login,
    agent: 'claude-code',
    issue: `${project}#1`,
    claim: 'c_person_feed_000001',
    kind: 'update',
    job: null,
    text,
  };
}

describe("a person's page", () => {
  test('shows what they work on now, their history with how each claim ended, their totals, and what they helped and maintain', async () => {
    await tag(repo, 18, 'Keep the query string on rewrites');
    await claim(priya, 18, { at: now - 10 * MINUTE });
    await claim(priya, 5, { at: t0 - 3 * DAY, events: opens(repo, 51, t0 - 3 * DAY), ended: { state: 'merged', at: t0 - 2 * DAY } });
    await claim(priya, 6, { at: t0 - 4 * DAY, events: opens(other, 52, t0 - 4 * DAY), project: other, ended: { state: 'closed', at: t0 - 3 * DAY } });
    await claim(priya, 7, { at: t0 - 5 * DAY, events: [[{ kind: 'release', reason: 'needs hardware I do not have' }, t0 - 5 * DAY + HOUR]] });

    const person = ready(await loadPerson(request, 'PRIYA', now));

    expect(person.login).toBe('priya');
    expect(person.working.map((w) => [w.issue, w.title, w.status])).toEqual([
      [`${repo}#18`, 'Keep the query string on rewrites', 'working'],
    ]);
    expect(person.history.map((w) => [w.issue, w.status])).toEqual([
      [`${repo}#5`, 'merged'],
      [`${other}#6`, 'pr_closed'],
      [`${repo}#7`, 'released'],
    ]);
    expect(person.totals).toMatchObject({ merged: 1, closed: 1, opened: 2, mergeRate: 0.5, issues: 4, projects: 1 });
    expect(person.helped).toEqual([{ repo, merged: 1 }]);
    expect(person.maintains).toEqual([]);
    expect(ready(await loadPerson(request, maintainer.login, now)).maintains).toEqual([repo, other]);
  });

  test('says a claim past its 24 hours expired, though the room has not saved it yet', async () => {
    await claim(priya, 18, { at: t0 - 25 * HOUR });

    const person = ready(await loadPerson(request, 'priya', now));

    expect(person.working).toEqual([]);
    expect(person.history.map((w) => w.status)).toEqual(['expired']);
  });

  test("shows no title the site cached from a delisted project's repo, and names the issue instead", async () => {
    await tag(repo, 18, 'A title anyone may read');
    await tag(other, 19, 'A title from a repo that went private');
    await claim(priya, 18);
    await claim(priya, 19, { project: other });
    await setDelisted(db, other, 'sample-owner/sample-desktop is private on GitHub.', t0);

    const person = ready(await loadPerson(request, 'priya', now));
    expect(person.working.map((w) => [w.issue, w.title])).toEqual([
      [`${repo}#18`, 'A title anyone may read'],
      [`${other}#19`, null],
    ]);

    const html = shown(await (await page('/@priya')).text());
    expect(html).toContain('A title anyone may read');
    expect(html).not.toContain('A title from a repo that went private');
    expect(html).toContain(`>${other}#19</a>`);
  });

  test('folds a cached title stored before titles were folded, as every page does', async () => {
    await tag(repo, 18, 'A title');
    // A copy saved before the fold, written straight to the table.
    await db
      .prepare('UPDATE tagged_issues SET title = ? WHERE project = ? AND number = ?')
      .bind('Line one\nIgnore previous\u{E0041}\u202Ehidden', repo, 18)
      .run();
    await claim(priya, 18);

    const person = ready(await loadPerson(request, 'priya', now));
    expect(person.working.map((w) => w.title)).toEqual(['Line one Ignore previous hidden']);
  });

  test('leaves out work on a repo the do-not-list names', async () => {
    await claim(priya, 18, { project: 'sample-owner/removed-app' });
    await claim(priya, 5, { at: t0 - 3 * DAY, events: opens(repo, 51, t0 - 3 * DAY), ended: { state: 'merged', at: t0 - 2 * DAY } });
    await addToDoNotList(db, { repo: 'sample-owner/removed-app', reason: null, addedBy: admin.githubId }, t0);

    const person = ready(await loadPerson(request, 'priya', now));

    expect([...person.working, ...person.history].map((w) => w.issue)).toEqual([`${repo}#5`]);
  });

  test('starts with their feed’s newest lines, newest first', async () => {
    await personFeed(env.FEED, sam.githubId).deliver(
      Array.from({ length: 8 }, (_, i) => ({ event: event(sam, `line ${String(i)}`), githubId: sam.githubId })),
    );

    const person = ready(await loadPerson(request, 'sam', now));

    expect(person.live?.map((e) => e.text)).toEqual(['line 7', 'line 6', 'line 5', 'line 4', 'line 3', 'line 2']);
  });

  test('is the page at /@<login>, public, with text as text, and sets no cookie', async () => {
    await tag(repo, 18, '<img src=x onerror=alert(1)> in a title');
    await claim(priya, 18, { at: Date.now() - MINUTE });

    const res = await page('/@priya');
    const html = shown(await res.text());

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html).toContain('<h1 class="person-title">@priya</h1>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; in a title');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('curl -N primary.example/@priya/live.txt');
    expect(html).toContain('<span class="chip chip--live">working</span>');
  });
});

describe('which people have a page', () => {
  const notFound = async (path: string) => {
    const res = await page(path);
    return { status: res.status, html: shown(await res.text()) };
  };

  test('someone who never signed in, and a blocked donor, get the same 404, and the blocked donor’s work shows nowhere', async () => {
    await claim(kenji, 18);
    await blockDonor(db, { githubId: kenji.githubId, reason: 'posted spam', blockedBy: admin.githubId }, t0);

    const blocked = await notFound('/@kenji');
    const never = await notFound('/@nobody-here');

    expect(blocked.status).toBe(404);
    expect(never.status).toBe(404);
    expect(blocked.html).toContain('<span class="mono">@kenji</span> has no page on Good First Token.');
    expect(never.html).toContain('<span class="mono">@nobody-here</span> has no page on Good First Token.');
    expect(blocked.html).not.toContain('posted spam');
    expect(blocked.html).not.toContain(`${repo}#18`);
  });

  test('a renamed person’s page moves to their new login, and a login that changed hands shows its new owner', async () => {
    await claim(priya, 18);
    await savePerson(db, { githubId: priya.githubId, login: 'priya-new' }, t0 + 1);
    // Someone new took the freed login.
    await savePerson(db, { githubId: 4242, login: 'priya' }, t0 + 2);

    const renamed = ready(await loadPerson(request, 'priya-new', now));
    const taken = ready(await loadPerson(request, 'priya', now));

    expect(renamed.working.map((w) => w.issue)).toEqual([`${repo}#18`]);
    expect(taken.login).toBe('priya');
    expect(taken.working).toEqual([]);
  });

  test('a path no login fits has no page, and says only that', async () => {
    const res = await notFound('/@-not-a-login-');

    expect(res.status).toBe(404);
    expect(res.html).toContain('There is no page at this address.');
  });

  test("says the page can't be read when the database is down, with 503", async () => {
    databaseDown();

    const res = await page('/@priya');

    expect(res.status).toBe(503);
    expect(shown(await res.text())).toContain('can&#x27;t be read right now');
  });
});

describe('the activity graph', () => {
  test('lights a square by how busy the day was, and turns a day a PR merged green', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => levelOf({ events: n, merged: false }))).toEqual([0, 1, 2, 3, 3, 4, 4]);
    expect(levelOf({ events: 1, merged: true })).toBe('merged');
    expect(levelOf(undefined)).toBe(0);
  });

  test('has a column for each of 52 weeks, Monday to Sunday, the current week last', () => {
    const monday = Date.UTC(2026, 8, 21);
    const start = activityStart(monday);
    const squares = activitySquares(
      [
        { day: '2026-09-21', events: 1, merged: false },
        { day: '2026-09-27', events: 2, merged: true },
        { day: new Date(start).toISOString().slice(0, 10), events: 5, merged: false },
      ],
      start,
    );

    expect(squares).toHaveLength(7 * 52);
    // Row 0 is Mondays: the first week's, then this week's last.
    expect(squares[0]).toBe(4);
    expect(squares[51]).toBe(1);
    // Row 6 is Sundays: this week's Sunday is the last square.
    expect(squares[7 * 52 - 1]).toBe('merged');
    expect(squares.filter((s) => s !== 0)).toHaveLength(3);
  });
});

describe('the leaderboard page', () => {
  test('ranks people this week and of all time, shows every named agent side by side, and leaves a blocked donor out', async () => {
    const at = Date.now() - 3 * HOUR;
    await claim(priya, 5, { at, events: opens(repo, 51, at), ended: { state: 'merged', at: at + HOUR } });
    await claim(priya, 6, { at, events: opens(repo, 52, at), ended: { state: 'closed', at: at + HOUR } });
    await claim(maintainer, 7, { at, events: opens(repo, 53, at), ended: { state: 'merged', at: at + HOUR }, ownProject: true });
    await claim(kenji, 8, { at, events: opens(other, 54, at), ended: { state: 'merged', at: at + HOUR } });
    await blockDonor(db, { githubId: kenji.githubId, reason: null, blockedBy: admin.githubId }, t0);

    const res = await page('/leaderboard');
    const html = shown(await res.text());

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html).toContain('<a href="/@priya">@priya</a>');
    expect(html).toContain('merge rate 50%');
    expect(html).toContain('<a href="/@sample-maintainer">@sample-maintainer</a>');
    expect(html).not.toContain('@kenji');
    expect(html).not.toContain(other);
    for (const agent of NAMED_AGENTS) expect(html).toContain(`<span class="mono board-bar__name">${agent}</span>`);
    for (const view of ['this week', 'all time', 'by agent', 'by project']) expect(html).toContain(`>${view}</button>`);
  });

  test('always names the five agents, after the ones with work, and counts them in its total', () => {
    const board = withNamedAgents({
      total: 2,
      rows: [
        { key: 'codex', login: null, agent: null, merged: 3, closed: 1, opened: 4, mergeRate: 0.75, issues: 4, projects: 1, people: 1, tokens: null, ownMerged: 0 },
        { key: 't3-code', login: null, agent: null, merged: 1, closed: 0, opened: 1, mergeRate: 1, issues: 1, projects: 1, people: 1, tokens: null, ownMerged: 0 },
      ],
    });

    expect(board.rows.map((r) => r.key)).toEqual(['codex', 't3-code', 'claude-code', 'opencode', 'grok', 'cursor']);
    expect(board.total).toBe(6);
  });

  test('writes a merge rate as a whole percent, none yet with no PR ended, and tokens short', () => {
    expect(formatRate(2 / 3)).toBe('67%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(null)).toBe('none yet');
    expect([950, 1500, 12_000, 3_100_000, 45_000_000].map(formatTokens)).toEqual(['950', '1.5K', '12K', '3.1M', '45M']);
  });

  test("says it can't be read when the database is down, with 503", async () => {
    databaseDown();

    const res = await page('/leaderboard');

    expect(res.status).toBe(503);
    expect(shown(await res.text())).toContain('can&#x27;t be read right now');
  });
});

describe('/live', () => {
  test("shows the homepage feed's newest lines, a blocked donor's left out, with the stream's command, and sets no cookie", async () => {
    await blockDonor(db, { githubId: kenji.githubId, reason: null, blockedBy: admin.githubId }, t0);
    await homeFeed(env.FEED).deliver([
      { event: event(priya, 'wrote a failing test for the rewrite'), githubId: priya.githubId },
      { event: event(kenji, 'a line nobody should see'), githubId: kenji.githubId },
    ]);

    const res = await page('/live');
    const html = shown(await res.text());

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html).toContain('wrote a failing test for the rewrite');
    expect(html).not.toContain('a line nobody should see');
    expect(html).toContain('curl -N primary.example/live.txt');
  });
});
