import type { FeedEvent } from '@goodfirsttoken/core';
import { people as fakePeople, repos as fakeRepos } from '@goodfirsttoken/github-fake/sample-data';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { blockDonor, getProject, listProjectsAskingForHelp, startOfWeek, topMergers } from '../../src/db';
import { SAMPLE_CLAIMS, SAMPLE_PEOPLE, SAMPLE_PROJECTS } from '../../src/dev/sample-work';
import { fieldOf, light, squareFor } from '../../src/home/live';
import { loadHome } from '../../src/home/load';
import { homeFeed } from '../../src/rooms/feed';
import { storedEvents } from '../feed/helpers';
import { admin, DAY, emptyDatabase, HOUR, kenji, priya, signIn } from '../db/helpers';
import { LOCAL_FAKE, runAsDevelopment, setEnv } from '../auth/helpers';

// What the homepage loads, and the dev-only route that gives a local site
// its sample work. Every person, repo, and line here is made up.

let restore: () => void = () => undefined;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, admin);
});

afterEach(() => {
  restore();
  restore = () => undefined;
});

/** Sets a variable the Worker reads for one test. */
function setVar(name: 'PRIMARY_DOMAIN', value: string): void {
  const vars = env as unknown as Record<string, string>;
  const before = vars[name] ?? '';
  vars[name] = value;
  const back = restore;
  restore = () => {
    vars[name] = before;
    back();
  };
}

// Each test's events fall on a day of their own, far ahead of the real one,
// since the home feed is shared by the tests in this file.
let dayNumber = 0;
let made = 0;

function nextDay(): number {
  dayNumber += 1;
  return Date.UTC(2101, 0, dayNumber, 12);
}

function event(at: number, person: { login: string }, text: string): FeedEvent {
  made += 1;
  return {
    id: `e_home${String(made).padStart(16, '0')}`,
    time: new Date(at).toISOString(),
    user: person.login,
    agent: 'claude-code',
    issue: 'sample-owner/sample-app#7',
    claim: 'c_home00000000000000001',
    kind: 'update',
    job: null,
    text,
  };
}

const request = new Request('http://localhost:5173/');

describe('the homepage', () => {
  test('names the site in its prompt by its host over https, and by its whole origin otherwise', async () => {
    // vitest.config.ts sets the primary domain.
    expect((await loadHome(request)).site).toBe('primary.example');

    setVar('PRIMARY_DOMAIN', '');
    expect((await loadHome(request)).site).toBe('http://localhost:5173');
    expect((await loadHome(new Request('https://gft.workers.test/'))).site).toBe('gft.workers.test');
  });

  test("starts the wall with the home feed's six newest lines, newest first, and counts the day's events", async () => {
    const now = nextDay();
    const yesterday = event(now - DAY, kenji, 'from the day before');
    const today = Array.from({ length: 8 }, (_, i) => event(now - HOUR + i, priya, `line ${String(i)}`));
    await homeFeed(env.FEED).deliver([yesterday, ...today].map((e) => ({ event: e, githubId: e.user === 'priya' ? priya.githubId : kenji.githubId })));

    const home = await loadHome(request, now);

    expect(home.day).toBe(new Date(now).toISOString().slice(0, 10));
    expect(home.live?.lines.map((e) => e.text)).toEqual(['line 7', 'line 6', 'line 5', 'line 4', 'line 3', 'line 2']);
    expect(home.live?.today).toBe(8);
    // Only the day's events light the field.
    expect(home.live?.squares).toEqual(fieldOf(today));
  });

  test("leaves a blocked donor's events out of the wall, the token field, and the day's count", async () => {
    const now = nextDay();
    const theirs = event(now, priya, 'priya today');
    const others = event(now + 1, kenji, 'kenji today');
    await homeFeed(env.FEED).deliver([
      { event: theirs, githubId: priya.githubId },
      { event: others, githubId: kenji.githubId },
    ]);
    await blockDonor(env.DB, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, now);

    const home = await loadHome(request, now);

    // The feed is shared with the tests above, whose lines of priya's are hidden now too.
    expect(home.live?.lines[0]?.text).toBe('kenji today');
    expect(home.live?.lines.filter((e) => e.user === 'priya')).toEqual([]);
    expect(home.live?.today).toBe(1);
    expect(home.live?.squares).toEqual(fieldOf([others]));
  });

  test('still loads, with the prompt, when the database is down, and says which parts it could not read', async () => {
    const down = { prepare: () => { throw new Error('D1 is down.'); } } as unknown as D1Database;
    const vars = env as unknown as { DB: D1Database };
    const db = vars.DB;
    vars.DB = down;
    restore = () => { vars.DB = db; };
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const home = await loadHome(request, nextDay());

    expect(home.site).toBe('primary.example');
    expect(home.merged).toBeNull();
    expect(home.help).toBeNull();
    warnings.mockRestore();
  });

  test("leaves the wall and the count out when the homepage's feed can't say who is blocked", async () => {
    const now = nextDay();
    await homeFeed(env.FEED).deliver([{ event: event(now, kenji, 'while D1 is down for the feed'), githubId: kenji.githubId }]);
    const down = { prepare: () => { throw new Error('D1 is down.'); } } as unknown as D1Database;
    await runInDurableObject(homeFeed(env.FEED), (instance) => {
      const live = instance as unknown as { env: Env };
      live.env = { ...live.env, DB: down };
    });
    restore = () => undefined;
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const home = await loadHome(request, now);

      expect(home.live).toBeNull();
      // The Worker's own D1 still answers.
      expect(home.merged).toEqual([]);
    } finally {
      await runInDurableObject(homeFeed(env.FEED), (instance) => {
        (instance as unknown as { env: Env }).env = env;
      });
      warnings.mockRestore();
    }
  });
});

describe('the token field', () => {
  test('lights the square an event picks, one step brighter each time up to the brightest, and a merge turns it green', () => {
    const one = { id: 'e_square', kind: 'update' as const };
    let squares = fieldOf([]);
    for (const level of [1, 2, 3, 4, 4]) {
      const lit = light(squares, one);
      squares = lit.squares;
      expect(lit.index).toBe(squareFor('e_square'));
      expect(squares[lit.index]).toBe(level);
    }
    expect(squares.filter((square) => square !== 0)).toHaveLength(1);

    squares = light(squares, { id: 'e_square', kind: 'pr_merged' }).squares;
    expect(squares[squareFor('e_square')]).toBe('merged');
    expect(light(squares, one).squares[squareFor('e_square')]).toBe('merged');
  });
});

describe('the dev-only seed', () => {
  const seed = (headers: HeadersInit = {}) =>
    exports.default.fetch('http://localhost:5173/dev/seed', { method: 'POST', headers });

  test.each(['staging', 'production'])('outside development, as in %s, does not exist and seeds nothing', async (environment) => {
    // GitHub is the fake on this machine, as for pnpm dev. Only the
    // environment differs.
    restore = setEnv({ ENVIRONMENT: environment, GH_WEB_URL: LOCAL_FAKE.web, GH_API_URL: LOCAL_FAKE.api });

    const res = await seed();

    expect(res.status).toBe(404);
    expect(await getProject(env.DB, 'sample-owner/sample-app')).toBeNull();
  });

  test('in development, gives the site sample projects and work, and seeding again makes no second copy', async () => {
    restore = runAsDevelopment();

    const first = await seed();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ projects: 5, claims: 10, lines: 10, merged: 5 });

    const help = await listProjectsAskingForHelp(env.DB, 5, Date.now());
    expect(help.projects.map(({ project, waiting }) => [project.repo, waiting])).toEqual([
      ['sample-owner/sample-desktop', 2],
      ['sample-owner/sample-app', 1],
      ['sample-owner/sample-bundler', 1],
      ['sample-owner/sample-tools', 0],
    ]);
    const from = startOfWeek(Date.now());
    const ranks = await topMergers(env.DB, { from, until: from + 7 * DAY, limit: 5 });
    expect(ranks.map(({ login, merged }) => [login, merged])).toEqual([
      ['kenji', 2],
      ['priya', 1],
      ['lena', 1],
      ['sam', 1],
    ]);
    await vi.waitFor(
      async () => {
        const lines = (await storedEvents(homeFeed(env.FEED))).map((e) => e.text);
        expect(lines).toContain('wrote a failing test: a rewrite from /docs/ keeps its slash');
      },
      { timeout: 5000, interval: 50 },
    );

    const again = await seed();
    expect(await again.json()).toMatchObject({ projects: 0, claims: 0, merged: 0 });
  });

  test("names only the GitHub fake's own sample people, and its made-up repos and their open issues", () => {
    for (const person of Object.values(SAMPLE_PEOPLE)) {
      expect(fakePeople.find((p) => p.login === person.login)?.id, person.login).toBe(person.githubId);
    }
    const repo = (name: string) => fakeRepos.find((r) => `${r.owner}/${r.name}` === name);
    for (const project of SAMPLE_PROJECTS) {
      expect(project.repo).toMatch(/^sample-owner\//);
      for (const issue of project.issues) {
        expect(repo(project.repo)?.issues?.find((i) => i.number === issue.number), `${project.repo}#${String(issue.number)}`).toMatchObject({
          title: issue.title,
          labels: issue.labels,
        });
      }
    }
    for (const claim of SAMPLE_CLAIMS) expect(repo(claim.project), claim.project).toBeDefined();
  });

  test('in development, on a host that is not this machine, does not exist and seeds nothing', async () => {
    restore = runAsDevelopment();

    for (const host of ['gft.example', 'gft.workers.test', '192.0.2.10:5173']) {
      const res = await exports.default.fetch(`http://${host}/dev/seed`, { method: 'POST' });
      expect(res.status, host).toBe(404);
    }
    expect(await getProject(env.DB, 'sample-owner/sample-app')).toBeNull();
  });

  test('refuses a POST from a page on another site', async () => {
    restore = runAsDevelopment();

    const res = await seed({ origin: 'https://elsewhere.example' });

    expect(res.status).toBe(403);
    expect(await getProject(env.DB, 'sample-owner/sample-app')).toBeNull();
  });
});
