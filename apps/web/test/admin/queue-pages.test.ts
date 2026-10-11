import { ADMIN_QUEUE_PAGE } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { adminDecide, adminSeedRepo, queuePage } from '../../src/admin/actions';
import type { Caller } from '../../src/auth/permissions';
import {
  addCandidate,
  addPolicyChange,
  askRemoval,
  changeSettings,
  createProject,
  reopenRegistration,
  savePerson,
} from '../../src/db';
import { Browser, signIn, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from '../mcp/helpers';
import { priorityEvidence } from '../priority-evidence';

// The admin queue a page at a time, in admin_queue and on /admin. A queue
// longer than a page is read for the page's items alone, so one look makes
// at most two calls to GitHub for each item on the page, whatever the queue
// holds. sample-admin is the admin here, and octo-maintainer registers the
// made-up sample-owner/sample-queued-N repos, which the test adds to the
// GitHub fake as copies of sample-harbor.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const ADMIN = { githubId: 1010, login: 'sample-admin' };
const MAINTAINER = { githubId: 1008, login: 'octo-maintainer' };
const HARBOR = 'sample-owner/sample-harbor';
const MINUTE = 60_000;
/** A queue longer than two pages, so a look at it has more to read than a page. */
const LONG = ADMIN_QUEUE_PAGE * 2 + 5;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  env.ADMIN_GITHUB_IDS = String(ADMIN.githubId);
  await savePerson(env.DB, MAINTAINER, Date.now());
  // These tests call the tools more often than the limit of 120 a minute allows.
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: { items: { id: string; repo: string; requestedAt: string }[]; more: number; next: string | null };
  isError?: boolean;
}

async function look(agent: ConnectedAgent, args: Record<string, unknown> = {}): Promise<Result> {
  return (await agent.client.callTool({ name: 'admin_queue', arguments: args })) as Result;
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text).join('\n');
}

/** The admin as the actions see them, with the GitHub token the fake gave their agent. */
function adminCaller(): Caller {
  const token = Object.entries(github.state.tokens).find(([, grant]) => grant.login === ADMIN.login)?.[0] ?? null;
  return { ...ADMIN, gitHubToken: () => Promise.resolve(token) };
}

/** A made-up public repo in the GitHub fake, a copy of sample-harbor. */
function fakeRepo(n: number): string {
  const template = github.state.repos[HARBOR];
  if (!template) throw new Error(`missing sample repo ${HARBOR}`);
  const name = `sample-queued-${String(n)}`;
  github.state.repos[`sample-owner/${name}`] = { ...template, id: 800_000 + n, name, issues: {} };
  return `sample-owner/${name}`;
}

/** A registration of a new made-up repo, waiting since `at`. */
async function registration(n: number, at: number): Promise<string> {
  const repo = fakeRepo(n);
  const project = await createProject(
    env.DB,
    { repo, status: 'pending', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: MAINTAINER.githubId },
    at,
  );
  if (!project) throw new Error(`${repo} was not registered`);
  return repo;
}

/** A crawler find for a new made-up repo, found at `at`. */
async function find(n: number, at: number): Promise<string> {
  const repo = fakeRepo(n);
  const candidate = await addCandidate(
    env.DB,
    {
      repo,
      facts: { stars: 10, createdAt: at - 365 * 86_400_000, pushedAt: at, ownerCreatedAt: at - 365 * 86_400_000 },
      policy: { quote: 'Agent pull requests are welcome.', url: `https://github.com/${repo}/blob/main/CONTRIBUTING.md`, tier: 'invites_agents' },
      settings: {},
      suggestedTags: [],
    },
    at,
  );
  if (!candidate) throw new Error(`${repo} was not found`);
  return repo;
}

/**
 * A queue of `size` items that waited a minute apart, the oldest first:
 * registrations, with a crawler find every fifth and a request to be removed
 * every seventh. Returns the repos in the order they started to wait.
 */
async function longQueue(size: number): Promise<string[]> {
  const start = Date.now() - (size + 10) * MINUTE;
  const repos: string[] = [];
  for (let n = 0; n < size; n++) {
    const at = start + n * MINUTE;
    if (n % 5 === 4) repos.push(await find(n, at));
    else if (n % 7 === 6) {
      const repo = fakeRepo(n);
      await askRemoval(env.DB, { repo, reason: 'We would rather not take agent PRs.', requestedBy: MAINTAINER.githubId }, at);
      repos.push(repo);
    } else repos.push(await registration(n, at));
  }
  return repos;
}

/** The GitHub calls made since the fake had recorded `from` of them. */
function callsSince(from: number) {
  return github.calls.slice(from);
}

/** More pages than a long queue has, so a queue that never ends fails the test instead of running on. */
const MAX_PAGES = 10;

/** Counts one more page read, and fails once there are more than a long queue has. */
function nextPage(pages: { read: number }): void {
  pages.read += 1;
  if (pages.read > MAX_PAGES) throw new Error(`The queue gave more than ${String(MAX_PAGES)} pages.`);
}

describe('admin_queue, a page at a time', () => {
  test('adding, expiring, and clearing evidence leaves mixed-kind page order and cursors unchanged', async () => {
    const repos = await longQueue(LONG);
    await connectAgent(github, ADMIN.login);
    const readAll = async () => {
      const pages = [];
      let after: string | null = null;
      do {
        const result = await queuePage(adminCaller(), { kinds: ['registration', 'candidate', 'removal', 'pause', 'policy_change'], ...(after === null ? {} : { after }) });
        const out = result.value;
        pages.push({ items: out.items.map(({ id, repo, requestedAt }) => ({ id, repo, requestedAt })), next: out.next, more: out.more });
        after = out.next ?? null;
      } while (after !== null);
      return pages;
    };
    const before = await readAll();
    const at = Date.now();
    const repo = repos[4];
    if (!repo) throw new Error('missing candidate');
    await adminSeedRepo(adminCaller(), { repo, evidence: priorityEvidence(at) }, at);
    expect(await readAll()).toEqual(before);
    vi.spyOn(Date, 'now').mockReturnValue(at + 31 * 86400000);
    expect(await readAll()).toEqual(before);
    const expired = await queuePage(adminCaller(), { kinds: ['candidate'] });
    expect(expired.value.items.find((item) => item.repo === repo)?.priority).toMatchObject({ qualifies: false, reasons: expect.arrayContaining(['metadata_old']) as unknown });
    await adminSeedRepo(adminCaller(), { repo, evidence: null }, at + 31 * 86400000);
    expect(await readAll()).toEqual(before);
  });
  test('one look at a queue longer than a page makes at most two calls to GitHub for each item on the page, and reads only those repos', async () => {
    const repos = await longQueue(LONG);
    const admin = await connectAgent(github, ADMIN.login);
    const before = github.calls.length;

    const result = await look(admin);

    const calls = callsSince(before);
    // The Limits row in docs/how-it-works.md says 20 items and at most 40 calls.
    expect(calls.length).toBeLessThanOrEqual(40);
    const shown = result.structuredContent?.items.map((item) => item.repo) ?? [];
    expect(shown).toEqual(repos.slice(0, 20));
    const read = new Set(calls.map((c) => decodeURIComponent(new URL(c.url).pathname)));
    const notShown = repos.slice(ADMIN_QUEUE_PAGE).filter((repo) => read.has(`/repos/${repo}`));
    expect(notShown).toEqual([]);
    expect(new Set(calls.map((c) => c.login))).toEqual(new Set([ADMIN.login]));
  });

  test('paging through a long queue shows every item once, the longest waiting first, and says how many more wait', async () => {
    const repos = await longQueue(LONG);
    const admin = await connectAgent(github, ADMIN.login);

    const seen: string[] = [];
    const more: number[] = [];
    let after: string | null | undefined;
    const pages = { read: 0 };
    do {
      nextPage(pages);
      const result = await look(admin, after === undefined || after === null ? {} : { after });
      expect(result.isError).toBeFalsy();
      seen.push(...(result.structuredContent?.items.map((item) => item.repo) ?? []));
      more.push(result.structuredContent?.more ?? -1);
      after = result.structuredContent?.next;
      if (after) expect(textOf(result)).toContain(`after: ${JSON.stringify(after)}`);
    } while (after);

    expect(seen).toEqual(repos);
    expect(more).toEqual([LONG - ADMIN_QUEUE_PAGE, LONG - 2 * ADMIN_QUEUE_PAGE, 0]);
  });

  test('an item decided between pages skips nothing on the next page, and an item added between pages waits at the end', async () => {
    const repos = await longQueue(LONG);
    const admin = await connectAgent(github, ADMIN.login);
    const first = await look(admin);
    const items = first.structuredContent?.items ?? [];
    const decided = items.filter((item) => item.id.startsWith('reg_')).slice(0, 3);
    for (const item of decided) {
      const outcome = await adminDecide(adminCaller(), { id: item.id, decision: 'reject', reason: 'Not now.' }, Date.now());
      expect(outcome.ok).toBe(true);
    }
    const added = await registration(LONG, Date.now());

    const seen: string[] = [];
    let after = first.structuredContent?.next ?? null;
    const pages = { read: 1 };
    while (after !== null) {
      nextPage(pages);
      const page = await look(admin, { after });
      seen.push(...(page.structuredContent?.items.map((item) => item.repo) ?? []));
      after = page.structuredContent?.next ?? null;
    }

    expect(seen).toEqual([...repos.slice(ADMIN_QUEUE_PAGE), added]);
  });

  test.each([
    ['a word', 'page-2'],
    ['a time that is no day', '2026-02-30T10:00:00.000Z~sample-owner/sample-harbor~reg_1'],
    ['no repo', '2026-02-03T10:00:00.000Z~~reg_1'],
  ])('an after that is %s is refused as bad input, and GitHub is asked nothing', async (_what, after) => {
    await longQueue(3);
    const admin = await connectAgent(github, ADMIN.login);
    const before = github.calls.length;

    const result = await look(admin, { after });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('after: must be the next value from an admin_queue answer');
    expect(callsSince(before)).toEqual([]);
  });

  test('a changed registration keeps its ID and place, while a registration made again and a newer policy change wait at the end with a new ID', async () => {
    const start = Date.now() - 60 * MINUTE;
    const changed = await registration(1, start);
    const again = await registration(2, start + MINUTE);
    const listed = fakeRepo(3);
    await savePerson(env.DB, ADMIN, start);
    const policy = { quote: 'Agent pull requests are welcome.', url: `https://github.com/${listed}/blob/main/CONTRIBUTING.md`, tier: 'invites_agents' } as const;
    await createProject(
      env.DB,
      { repo: listed, status: 'approved', source: 'policy', policy, settings: { tags: ['help wanted'] }, addedBy: ADMIN.githubId },
      start,
    );
    const facts = { stars: 10, createdAt: start - 365 * 86_400_000, pushedAt: start, ownerCreatedAt: start - 365 * 86_400_000 };
    const reading = { repo: listed, facts, policy, sources: [], aiSentences: [], moreAiSentences: 0 };
    await addPolicyChange(env.DB, reading, start + 2 * MINUTE);
    const later = await registration(4, start + 3 * MINUTE);
    const kinds = ['registration', 'policy_change'] as const;
    const idsOf = async () => {
      const page = await queuePage(adminCaller(), { kinds });
      return page.value.items.map((item) => [item.repo, item.id] as const);
    };
    const before = await idsOf();
    expect(before.map(([repo]) => repo)).toEqual([changed, again, listed, later]);
    const idOf = (ids: typeof before, repo: string) => ids.find(([r]) => r === repo)?.[1];

    const settings = await changeSettings(env.DB, changed, { tags: ['good first issue'] }, MAINTAINER.githubId, start + 10 * MINUTE);
    expect(settings?.ok).toBe(true);
    const rejected = await adminDecide(adminCaller(), { id: idOf(before, again) ?? '', decision: 'reject', reason: 'Not now.' }, start + 11 * MINUTE);
    expect(rejected.ok).toBe(true);
    expect(await reopenRegistration(env.DB, again, { tags: ['help wanted'] }, MAINTAINER.githubId, start + 12 * MINUTE)).not.toBeNull();
    await addPolicyChange(env.DB, reading, start + 13 * MINUTE);

    const after = await idsOf();
    expect(after.map(([repo]) => repo)).toEqual([changed, later, again, listed]);
    expect(idOf(after, changed)).toBe(idOf(before, changed));
    expect(idOf(after, again)).not.toBe(idOf(before, again));
    expect(idOf(after, listed)).not.toBe(idOf(before, listed));
  });

  test('a look with one kind pages through that kind alone', async () => {
    const repos = await longQueue(LONG);
    const finds = repos.filter((_repo, n) => n % 5 === 4);

    const result = await queuePage(adminCaller(), { kinds: ['candidate'] });

    expect(result).toMatchObject({ ok: true, value: { more: 0, next: null } });
    expect(result.value.items.map((item) => item.repo)).toEqual(finds);
  });
});

/** The HTML of one /admin page, and the address of its next page, if it links one. */
async function adminPage(browser: Browser, path: string): Promise<{ html: string; next: string | null }> {
  const page = await browser.fetch(path);
  expect(page.status).toBe(200);
  const html = await page.text();
  const href = /<a [^>]*href="([^"]*)"[^>]*>next page<\/a>/.exec(html)?.[1] ?? null;
  return { html, next: href === null ? null : href.replaceAll('&amp;', '&') };
}

/** Which of `repos` a page of /admin shows, each as an item's heading. */
function shownRepos(html: string, repos: readonly string[]): string[] {
  return repos.filter((repo) => html.includes(`>${repo}</h3>`));
}

/** The HTML of the section of /admin that `label` names. */
function sectionOf(html: string, label: string): string {
  const start = html.indexOf(`aria-label="${label}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

describe('/admin, a page at a time', () => {
  test('each section counts what waits on this page, and says how many more of its kind wait on other pages', async () => {
    // A page and one more of registrations, then a request to be removed,
    // which waits on the second page.
    const start = Date.now() - 60 * MINUTE;
    for (let n = 0; n <= ADMIN_QUEUE_PAGE; n++) await registration(n, start + n * MINUTE);
    const asked = fakeRepo(ADMIN_QUEUE_PAGE + 1);
    await askRemoval(
      env.DB,
      { repo: asked, reason: 'We would rather not take agent PRs.', requestedBy: MAINTAINER.githubId },
      start + (ADMIN_QUEUE_PAGE + 1) * MINUTE,
    );
    const browser = new Browser();
    await signIn(browser, github, ADMIN.login);
    const total = ADMIN_QUEUE_PAGE + 1;

    const first = await adminPage(browser, '/admin');
    const removals = sectionOf(first.html, 'removal requests');
    expect(removals).not.toContain('No requests to be removed.');
    expect(removals).toContain('>0 of 1</span>');
    expect(removals).toContain('None on this page. 1 more waits after this page.');
    const registrations = sectionOf(first.html, 'registrations');
    expect(registrations).toContain(`>${String(ADMIN_QUEUE_PAGE)} of ${String(total)}</span>`);
    expect(registrations).toContain('1 more waits after this page.');
    const finds = sectionOf(first.html, 'crawler candidates');
    expect(finds).toContain('No finds waiting.');
    expect(finds).toContain('>0</span>');

    expect(first.next).not.toBeNull();
    const second = await adminPage(browser, first.next ?? '');
    const removalsAfter = sectionOf(second.html, 'removal requests');
    expect(removalsAfter).toContain(`>${asked}</h3>`);
    expect(removalsAfter).toContain('>1</span>');
    expect(removalsAfter).not.toContain('after this page');
    const registrationsAfter = sectionOf(second.html, 'registrations');
    expect(registrationsAfter).toContain(`>1 of ${String(total)}</span>`);
    expect(registrationsAfter).toContain(`${String(ADMIN_QUEUE_PAGE)} wait before this page.`);
    expect(registrationsAfter).not.toContain('after this page');
  });

  test('the page reads GitHub for its own items alone, links the next page, and paging shows every item once', async () => {
    const repos = await longQueue(LONG);
    const browser = new Browser();
    await signIn(browser, github, ADMIN.login);

    const seen: string[] = [];
    const counts: string[] = [];
    let path: string | null = '/admin';
    const pages = { read: 0 };
    while (path !== null) {
      nextPage(pages);
      const before = github.calls.length;
      const { html, next }: { html: string; next: string | null } = await adminPage(browser, path);
      expect(callsSince(before).length).toBeLessThanOrEqual(ADMIN_QUEUE_PAGE * 2);
      seen.push(...shownRepos(html, repos));
      counts.push(/(\d+) more wait after these\./.exec(html)?.[1] ?? 'none');
      path = next;
    }

    expect([...seen].sort()).toEqual([...repos].sort());
    expect(seen.length).toBe(new Set(seen).size);
    expect(counts).toEqual([String(LONG - ADMIN_QUEUE_PAGE), String(LONG - 2 * ADMIN_QUEUE_PAGE), 'none']);
  });

  test('an address whose page of the queue is no page shows no queue and no section, says why, and asks GitHub nothing', async () => {
    const repos = await longQueue(3);
    const browser = new Browser();
    await signIn(browser, github, ADMIN.login);
    const before = github.calls.length;

    const { html } = await adminPage(browser, '/admin?after=page-2');

    expect(html).toContain('No page of the queue shows. after: must be the next value from an admin_queue answer.');
    expect(shownRepos(html, repos)).toEqual([]);
    expect(callsSince(before)).toEqual([]);
    // Items wait, so no section may say none do.
    for (const none of ['No requests to be removed.', 'No finds waiting.', 'No registrations waiting.', 'None on this page.']) {
      expect(html).not.toContain(none);
    }
  });
});
