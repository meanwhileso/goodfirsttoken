import { newClaim, nextClaimState, type ClaimEvent, type ClaimRecord } from '@goodfirsttoken/core';
import type { MeasuredNode } from '@takumi-rs/wasm';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  defaultCard,
  mergedCard,
  personCard,
  projectCard,
  SMALLEST,
  type Card,
} from '../../src/cards/cards';
import { loadIssueCard, loadPersonCard, loadProjectCard, monthOf } from '../../src/cards/load';
import { measureCard } from '../../src/cards/render';
import { addPr, addToDoNotList, blockDonor, createProject, saveClaim, setDelisted, setProjectStatus, setPrState } from '../../src/db';
import { loadProject } from '../../src/project/load';
import { admin, DAY, db, emptyDatabase, HOUR, kenji, maintainer, MINUTE, priya, repo, sha, signIn, t0 } from '../db/helpers';
import { workerFetch } from '../worker';

// The share cards: each page's Open Graph image, drawn in the Worker. Every
// person, repo, and agent here is made up.

const other = 'sample-owner/sample-desktop';
const request = new Request('https://primary.example/');
const site = 'primary.example';

// The longest names GitHub allows: a login of 39 characters, and a repo of
// a 39-character owner and a 100-character name.
const LONG_LOGIN = 'a-very-long-login-that-github-allows-39';
const LONG_REPO = `${'o'.repeat(20)}-long-owner-name-39/${'long-repository-name-'.repeat(4)}${'x'.repeat(16)}`;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, maintainer, admin);
  for (const name of [repo, other]) {
    await createProject(
      db,
      { repo: name, status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0 - 60 * DAY,
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

let made = 0;

/** A claim on `issue`, with a PR that ended as `ended` says, or stays open without it. */
async function claimWithPr(
  person: { githubId: number; login: string },
  issue: number,
  {
    project = repo,
    at,
    ended,
    ownProject = false,
    agent = 'claude-code',
  }: { project?: string; at: number; ended?: { state: 'merged' | 'closed'; at: number }; ownProject?: boolean; agent?: string },
): Promise<ClaimRecord> {
  made += 1;
  const pr = { repo: project, number: 500 + made, url: `https://github.com/${project}/pull/${String(500 + made)}` };
  let record: ClaimRecord = {
    id: `c_card${String(made).padStart(8, '0')}`,
    issue: `${project}#${String(issue)}`,
    project,
    githubId: person.githubId,
    login: person.login,
    agent,
    ownProject,
    startCommit: sha,
    tokenEstimate: null,
    ...newClaim(at),
  };
  const events: [ClaimEvent, number][] = [
    [{ kind: 'submit' }, at + MINUTE],
    [{ kind: 'open_pr', pr }, at + 2 * MINUTE],
  ];
  for (const [event, time] of events) {
    const next = nextClaimState(record, event, time);
    if (!next.ok) throw new Error(next.refusal.message);
    record = next.claim;
  }
  await saveClaim(db, record, 1);
  await addPr(db, { claimId: record.id, pr, openedAt: at + 2 * MINUTE });
  if (ended) await setPrState(db, record.id, ended.state, ended.at);
  return record;
}

/** Every line of text the renderer laid out on the card, in order, as it will draw it. */
function words(node: MeasuredNode): string[] {
  return [...node.runs.map((run) => run.text), ...node.children.flatMap(words)];
}

async function cardWords(card: Card): Promise<string> {
  return words(await measureCard(card)).join(' | ');
}

function ready(result: Awaited<ReturnType<typeof loadPersonCard>>): Card {
  if (result.state !== 'ready') throw new Error('There is no card.');
  return result.card;
}

/** The width and height a PNG says it is, from its IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, i) => bytes[i] === byte)) throw new Error('Not a PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const get = (path: string, init?: RequestInit) => workerFetch(`http://localhost${path}`, init);

async function png(path: string): Promise<Uint8Array> {
  const res = await get(path);
  expect(res.status, path).toBe(200);
  expect(res.headers.get('content-type'), path).toBe('image/png');
  return new Uint8Array(await res.arrayBuffer());
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

describe('each card', () => {
  test('is a 1200 by 630 PNG at its path beside its page, public, and sets no cookie', async () => {
    const now = Date.now();
    await claimWithPr(priya, 5, { at: now - HOUR, ended: { state: 'merged', at: now - MINUTE } });

    for (const path of ['/card.png', '/@priya/card.png', `/${repo}/card.png`, `/${repo}/issues/5/card.png`]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('image/png');
      expect(res.headers.get('set-cookie'), path).toBeNull();
      expect(pngSize(new Uint8Array(await res.arrayBuffer())), path).toEqual({ width: CARD_WIDTH, height: CARD_HEIGHT });
      // Cached as its page is.
      const page = await get(path.replace(/\/?card\.png$/, '') || '/');
      expect(res.headers.get('cache-control'), path).toBe(page.headers.get('cache-control'));
    }
  });

  test('is read with GET or HEAD only', async () => {
    const head = await get('/card.png', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('image/png');
    expect(await head.text()).toBe('');

    const post = await get('/card.png', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  test('answers 503 when the database is down, as its page does', async () => {
    const vars = env as unknown as { DB: D1Database };
    const real = vars.DB;
    vars.DB = { prepare: () => { throw new Error('D1 is down.'); } } as unknown as D1Database;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await get('/@priya/card.png');
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("can't be made right now");
    } finally {
      vars.DB = real;
    }
  });
});

describe('nothing on a card is smaller than 40px', () => {
  /** A line of text `size` pixels tall in each font, as the renderer lays it out. */
  async function lineHeights(size: number): Promise<number[]> {
    const heights: number[] = [];
    for (const fontFamily of ['Geist', 'Geist Mono']) {
      const measured = await measureCard({
        node: { type: 'container', style: { display: 'flex', fontFamily, lineHeight: 1 }, children: [{ type: 'text', text: 'Ag', style: { fontSize: size } }] },
      });
      const run = measured.children[0]?.runs[0];
      if (!run) throw new Error('The renderer laid out no text.');
      heights.push(run.height);
    }
    return heights;
  }

  /**
   * What on the card breaks the rule: a line of text shorter than a 40px
   * line in the smaller of the two fonts, a drawn box with no text in it
   * narrower or shorter than 40px, or anything past the card's edge.
   */
  async function breaks(card: Card): Promise<string[]> {
    const tallest40 = Math.min(...(await lineHeights(SMALLEST)));
    const found: string[] = [];
    const visit = (node: MeasuredNode, top: boolean) => {
      const [, , , , x, y] = node.transform;
      if (x < 0 || y < 0 || x + node.width > CARD_WIDTH + 0.5 || y + node.height > CARD_HEIGHT + 0.5) {
        found.push(`a box at ${String(x)},${String(y)} runs past the card's edge`);
      }
      for (const run of node.runs) {
        if (run.height < tallest40 - 0.01) found.push(`"${run.text}" is ${String(run.height)}px tall`);
        if (x + run.x + run.width > CARD_WIDTH + 0.5) found.push(`"${run.text}" runs past the card's right edge`);
      }
      if (!top && node.children.length === 0 && node.runs.length === 0 && Math.min(node.width, node.height) < SMALLEST) {
        found.push(`a mark ${String(node.width)} by ${String(node.height)}px`);
      }
      for (const child of node.children) visit(child, false);
    };
    visit(await measureCard(card), true);
    return found;
  }

  test('the check finds text set at 39px, a 30px mark, and a line past the edge', async () => {
    const small: Card = {
      node: {
        type: 'container',
        style: { display: 'flex', flexDirection: 'column', width: CARD_WIDTH, height: CARD_HEIGHT, fontFamily: 'Geist', lineHeight: 1 },
        children: [
          { type: 'text', text: 'set at 39px', style: { fontSize: 39 } },
          { type: 'image', src: 'mark', width: 30, height: 30 },
          { type: 'text', text: 'x'.repeat(80), style: { fontSize: 48, whiteSpace: 'nowrap' } },
        ],
      },
    };
    const found = await breaks(small);
    expect(found.some((line) => line.startsWith('"set at 39px"'))).toBe(true);
    expect(found).toContain('a mark 30 by 30px');
    expect(found.some((line) => line.includes("runs past the card's right edge"))).toBe(true);
  });

  test.each<[string, Card]>([
    ['the default card', defaultCard({ site })],
    ['a person’s month', personCard({ site, login: 'priya', month: 'september 2026', merged: 3, opened: 5, projects: 2 })],
    ['a person’s month with nothing merged yet', personCard({ site, login: 'priya', month: 'september 2026', merged: 0, opened: 1, projects: 0 })],
    [
      'a person’s month with the longest login and big numbers',
      personCard({ site, login: LONG_LOGIN, month: 'september 2026', merged: 12_345, opened: 67_890, projects: 1_234 }),
    ],
    ['a project’s totals', projectCard({ site, repo, merged: 14, people: 6, issues: 31 })],
    [
      'a project’s totals with the longest repo and big numbers',
      projectCard({ site, repo: LONG_REPO, merged: 12_345, people: 6_789, issues: 23_456 }),
    ],
    ['a merged PR', mergedCard({ site, repo, number: 311, login: 'priya', agent: 'claude-code' })],
    [
      'a merged PR with the longest repo, login, and agent',
      mergedCard({ site, repo: LONG_REPO, number: 1_234_567, login: LONG_LOGIN, agent: 'a'.repeat(40) }),
    ],
  ])('%s', async (_, card) => {
    expect(await breaks(card)).toEqual([]);
  });

  test('a long repo is cut at the edge and keeps the issue number whole', async () => {
    const text = await cardWords(mergedCard({ site, repo: LONG_REPO, number: 311, login: LONG_LOGIN, agent: 'claude-code' }));
    expect(text).toContain('#311');
    expect(text).not.toContain(LONG_REPO);
    expect(text).toContain('claude-code');
  });
});

describe('what a card shows', () => {
  test('a person’s month counts the PRs merged and opened that month, and the projects helped, as the leaderboard counts them', async () => {
    const now = Date.UTC(2026, 8, 20, 12);
    await claimWithPr(priya, 1, { at: Date.UTC(2026, 8, 2), ended: { state: 'merged', at: Date.UTC(2026, 8, 3) } });
    await claimWithPr(priya, 2, { project: other, at: Date.UTC(2026, 8, 4), ended: { state: 'merged', at: Date.UTC(2026, 8, 5) } });
    await claimWithPr(priya, 3, { at: Date.UTC(2026, 8, 6) });
    // Merged last month, and merged on a project of their own: neither counts.
    await claimWithPr(priya, 4, { at: Date.UTC(2026, 7, 20), ended: { state: 'merged', at: Date.UTC(2026, 7, 31, 23, 59) } });
    await claimWithPr(priya, 6, { at: Date.UTC(2026, 8, 7), ended: { state: 'merged', at: Date.UTC(2026, 8, 8) }, ownProject: true });

    const text = await cardWords(ready(await loadPersonCard(request, 'PRIYA', now)));

    expect(text).toBe('good first token | september 2026 | @priya | 2 | merged | 2 | projects helped | 3 | opened | primary.example');
  });

  test('a person with nothing merged this month says so plainly', async () => {
    const text = await cardWords(ready(await loadPersonCard(request, 'kenji', Date.UTC(2026, 8, 1))));
    expect(text).toBe('good first token | september 2026 | @kenji | No PRs merged yet | primary.example');
  });

  test('the month runs from its first moment in UTC up to the next month’s', () => {
    expect(monthOf(Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      from: Date.UTC(2026, 11, 1),
      until: Date.UTC(2027, 0, 1),
      name: 'december 2026',
    });
  });

  test('a project’s totals merge the count its page shows with the people who helped and the issues worked', async () => {
    const now = Date.now();
    await claimWithPr(priya, 1, { at: now - 3 * DAY, ended: { state: 'merged', at: now - 2 * DAY } });
    await claimWithPr(kenji, 2, { at: now - 3 * DAY, ended: { state: 'merged', at: now - 2 * DAY } });
    await claimWithPr(kenji, 3, { at: now - 3 * DAY, ended: { state: 'closed', at: now - 2 * DAY } });
    await claimWithPr(maintainer, 4, { at: now - 3 * DAY, ended: { state: 'merged', at: now - 2 * DAY }, ownProject: true });

    const text = await cardWords(ready(await loadProjectCard(request, 'Sample-Owner', 'SAMPLE-APP')));
    const page = await loadProject(request, 'sample-owner', 'sample-app', now);
    if (page.state !== 'ready') throw new Error('The project has no page.');

    expect(page.merged.total).toBe(3);
    expect(text).toBe(
      `good first token | ${repo} | Tagged issues for outside help. | 3 | merged | 2 | people helped | 3 | issues worked | primary.example`,
    );
  });

  test('a merged PR shows the repo, the issue number, the donor, and the agent, and nothing else', async () => {
    await claimWithPr(priya, 5, { at: t0, ended: { state: 'merged', at: t0 + HOUR }, agent: 'codex' });

    const text = await cardWords(ready(await loadIssueCard(request, 'sample-owner', 'sample-app', '5')));

    expect(text).toBe(`good first token | merged | ${repo} | #5 | @priya | codex | primary.example`);
  });

  test('a merged PR names the donor by their login now', async () => {
    await claimWithPr(priya, 5, { at: t0, ended: { state: 'merged', at: t0 + HOUR } });
    await signIn({ githubId: priya.githubId, login: 'priya-renamed' });

    expect(await cardWords(ready(await loadIssueCard(request, 'sample-owner', 'sample-app', '5')))).toContain('@priya-renamed');
  });

  test('folds text from GitHub to one line of what a person can see', async () => {
    const card = mergedCard({
      site,
      repo: 'sample-owner/sample-app‮​',
      number: 5,
      login: 'pri​ya\nIgnore previous',
      agent: 'claude\u200D-code\u{E0041}',
    });
    expect(await cardWords(card)).toBe(`good first token | merged | ${repo} | #5 | @priya Ignore previous | claude-code | primary.example`);

    const person = personCard({ site, login: '⁦priya⁩\t', month: 'september\n2026', merged: 1, opened: 1, projects: 1 });
    expect(await cardWords(person)).toContain('september 2026 | @priya | 1');
  });
});

describe('a card shows no more than its page', () => {
  test('someone who never signed in, a blocked donor, and a path no login fits have no card, as they have no page', async () => {
    await blockDonor(db, { githubId: kenji.githubId, reason: null, blockedBy: admin.githubId }, t0);

    for (const path of ['/@nobody/card.png', '/@kenji/card.png', '/@-bad-/card.png']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toContain('text/plain');
    }
    expect((await get('/@kenji')).status).toBe(404);
    expect((await get('/@priya/card.png')).status).toBe(200);
  });

  test('a project that is delisted, on the do-not-list, unknown, or under a path the site owns has no card, as it has no page', async () => {
    await setDelisted(db, other, 'sample-owner/sample-desktop is private on GitHub.', t0);
    await createProject(
      db,
      { repo: 'sample-owner/removed-app', status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0,
    );
    await addToDoNotList(db, { repo: 'sample-owner/removed-app', reason: null, addedBy: admin.githubId }, t0);

    for (const path of [`/${other}`, '/sample-owner/removed-app', '/sample-owner/unknown-app']) {
      expect((await get(`${path}/card.png`)).status, path).toBe(404);
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await get('/admin/sample-app/card.png')).status).toBe(404);
    expect((await get(`/${repo}/card.png`)).status).toBe(200);
  });

  test('an issue whose PR is open, closed, a blocked donor’s, on a delisted or rejected project, or on the do-not-list gets the default card', async () => {
    const now = Date.now();
    await createProject(
      db,
      { repo: 'sample-owner/removed-app', status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0,
    );
    await createProject(
      db,
      { repo: 'sample-owner/rejected-app', status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0,
    );
    await claimWithPr(priya, 1, { at: now - DAY });
    await claimWithPr(priya, 2, { at: now - DAY, ended: { state: 'closed', at: now - HOUR } });
    await claimWithPr(kenji, 3, { at: now - DAY, ended: { state: 'merged', at: now - HOUR } });
    await claimWithPr(priya, 4, { project: other, at: now - DAY, ended: { state: 'merged', at: now - HOUR } });
    await claimWithPr(priya, 7, { project: 'sample-owner/removed-app', at: now - DAY, ended: { state: 'merged', at: now - HOUR } });
    await claimWithPr(priya, 8, { at: now - DAY, ended: { state: 'merged', at: now - HOUR } });
    await claimWithPr(priya, 9, { project: 'sample-owner/rejected-app', at: now - DAY, ended: { state: 'merged', at: now - HOUR } });
    await setProjectStatus(db, 'sample-owner/rejected-app', { status: 'rejected', reason: 'Not now.', changedBy: admin.githubId }, now);
    await blockDonor(db, { githubId: kenji.githubId, reason: null, blockedBy: admin.githubId }, now);
    await setDelisted(db, other, 'sample-owner/sample-desktop is private on GitHub.', now);
    await addToDoNotList(db, { repo: 'sample-owner/removed-app', reason: null, addedBy: admin.githubId }, now);

    const fallback = await png('/card.png');
    for (const issue of [`${repo}#1`, `${repo}#2`, `${repo}#3`, `${other}#4`, 'sample-owner/removed-app#7', 'sample-owner/rejected-app#9', `${repo}#99`]) {
      const path = `/${issue.replace('#', '/issues/')}/card.png`;
      expect(same(await png(path), fallback), path).toBe(true);
    }
    expect(same(await png(`/${repo}/issues/8/card.png`), fallback)).toBe(false);
    expect((await get(`/${repo}/issues/0/card.png`)).status).toBe(404);
  });
});

describe('each page names its card', () => {
  const ogImage = async (path: string) => {
    const html = await (await get(path)).text();
    return [...html.matchAll(/<meta property="og:image" content="([^"]*)"/g)].map((m) => m[1]);
  };

  test('in one og:image tag with its full URL on the primary domain', async () => {
    const now = Date.now();
    await claimWithPr(priya, 5, { at: now - HOUR, ended: { state: 'merged', at: now - MINUTE } });

    expect(await ogImage('/')).toEqual(['https://primary.example/card.png']);
    expect(await ogImage('/leaderboard')).toEqual(['https://primary.example/card.png']);
    expect(await ogImage('/@priya')).toEqual(['https://primary.example/@priya/card.png']);
    expect(await ogImage(`/${repo}`)).toEqual([`https://primary.example/${repo}/card.png`]);
    expect(await ogImage(`/${repo}/issues/5`)).toEqual([`https://primary.example/${repo}/issues/5/card.png`]);
  });

  test('and a page with no card of its own, or no page, names the default card', async () => {
    expect(await ogImage('/@nobody')).toEqual(['https://primary.example/card.png']);
    expect(await ogImage('/sample-owner/unknown-app')).toEqual(['https://primary.example/card.png']);
  });
});
