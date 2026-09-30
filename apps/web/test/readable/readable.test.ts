import { openProjectFileSchema, openProjectSchema, openProjectsFileSchema, type FeedEvent, type Policy } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addToDoNotList,
  blockDonor,
  createProject,
  saveIssues,
  setDelisted,
  setProjectStatus,
} from '../../src/db';
import { loadProjectsFile } from '../../src/readable/data';
import { MARKDOWN_ROUTES, NO_MARKDOWN } from '../../src/readable/routes';
import { homeFeed } from '../../src/rooms/feed';
import { issueRoom } from '../../src/rooms/issue-room';
import { routeTree } from '../../src/routeTree.gen';
import { Browser, ORIGIN, signIn as signInOnGitHub, startGitHub } from '../auth/helpers';
import { admin, db, emptyDatabase, kenji, maintainer, priya, registeredProject, repo, sha, signIn, t0 } from '../db/helpers';
import { workerFetch } from '../worker';

// The site in the forms agents read: each page's markdown version, the JSON
// data, /llms.txt, /robots.txt, /sitemap.xml, and every page's metadata, all
// through the Worker. Every person, repo, policy, and line here is made up.

const POLICY: Policy = {
  quote: 'Agent pull requests are welcome on issues labeled help wanted.',
  url: 'https://github.com/sample-owner/sample-listed/blob/main/CONTRIBUTING.md#ai',
  tier: 'invites_agents',
};

let restore: () => void = () => undefined;

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, admin, maintainer);
});

afterEach(() => {
  restore();
  restore = () => undefined;
  vi.restoreAllMocks();
});

const get = (path: string, init: RequestInit = {}) => workerFetch(`http://localhost${path}`, init);
const asMarkdown = { headers: { accept: 'text/markdown' } };

/** The path of a page's markdown version. */
function md(path: string): string {
  return path === '/' ? '/index.md' : `${path}.md`;
}

async function policyListing(name: string, policy: Policy = POLICY) {
  const made = await createProject(
    db,
    { repo: name, status: 'approved', source: 'policy', policy, settings: { tags: ['help wanted'] }, addedBy: admin.githubId },
    t0,
  );
  if (made === null) throw new Error(`${name} is already a project`);
  return made;
}

/** Caches an issue for a project, as the sync would. */
async function tag(project: string, issue: string, title = `Issue ${issue}`, labels = ['help wanted']) {
  await saveIssues(db, [{ issue, project, title, labels, linkedPr: null, syncedAt: t0 }]);
}

/** A claim by priya on `issue`, in its room, with a line posted to it. */
async function claimWithLine(issue: string, line: string) {
  const room = issueRoom(env.ISSUE_ROOM, issue);
  const made = await room.claim({
    issue,
    project: repo,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    slots: 3,
  });
  if (!made.ok) throw new Error(made.refusal.message);
  const posted = await room.postUpdate({ claimId: made.claim.id, githubId: priya.githubId, text: line });
  if (!posted.ok || !posted.posted) throw new Error('The line was not posted.');
  return made.claim;
}

function databaseDown(): void {
  const vars = env as unknown as { DB: D1Database };
  const real = vars.DB;
  vars.DB = { prepare: () => { throw new Error('D1 is down.'); }, batch: () => Promise.reject(new Error('D1 is down.')) } as unknown as D1Database;
  restore = () => { vars.DB = real; };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

/** Every page route in the route tree, by its ID: the routes that draw a page, and not the endpoints. */
function pageRoutes(): string[] {
  const found: string[] = [];
  const visit = (route: { options?: { id?: string; component?: unknown }; children?: unknown }) => {
    if (route.options?.component !== undefined && route.options.id !== undefined) found.push(route.options.id);
    const children = route.children;
    const list = Array.isArray(children) ? children : typeof children === 'object' && children !== null ? Object.values(children) : [];
    for (const child of list as (typeof route)[]) visit(child);
  };
  visit(routeTree);
  return found;
}

describe("every page's markdown version", () => {
  test('every page in the route tree has a markdown version, or a reason it has none', () => {
    const pages = pageRoutes();
    const covered = new Set([...MARKDOWN_ROUTES.map((route) => route.route), ...Object.keys(NO_MARKDOWN)]);

    expect(pages.length).toBeGreaterThan(10);
    expect(pages.filter((page) => !covered.has(page))).toEqual([]);
    // And nothing there is for a route the tree doesn't have.
    expect([...covered].filter((id) => !pages.includes(id))).toEqual([]);
  });

  // A path for each page that has a markdown version, to visit. A page added
  // to MARKDOWN_ROUTES with no path here fails the test below.
  const SAMPLE_PATHS: Record<string, string> = {
    '/': '/',
    '/projects': '/projects',
    '/leaderboard': '/leaderboard',
    '/live': '/live',
    '/maintainers': '/maintainers',
    '/design': '/design',
    '/sign-in': '/sign-in',
    '/me': '/me',
    '/admin': '/admin',
    '/@{$user}': '/@priya',
    '/$owner/$repo/': `/${repo}`,
    '/$owner/$repo/issues/$number': `/${repo}/issues/12`,
  };

  test('each page answers at its path plus .md, and to Accept: text/markdown, with markdown and the status its HTML page has', async () => {
    await registeredProject();
    await tag(repo, `${repo}#12`);
    await claimWithLine(`${repo}#12`, 'wrote a failing test');

    for (const route of MARKDOWN_ROUTES) {
      const path = SAMPLE_PATHS[route.route];
      expect(path, `no sample path for ${route.route}`).toBeDefined();
      if (path === undefined) continue;
      const html = await get(path);
      const byPath = await get(md(path));
      const byAccept = await get(path, asMarkdown);

      expect(byPath.status, path).toBe(html.status);
      expect(byAccept.status, path).toBe(html.status);
      if (html.status === 200) {
        expect(byPath.headers.get('content-type'), path).toBe('text/markdown; charset=utf-8');
        const body = await byPath.text();
        expect(body.startsWith('# '), path).toBe(true);
        expect(await byAccept.text(), path).toBe(body);
        expect(html.headers.get('vary'), path).toContain('Accept');
      }
    }
  });

  test("/start.md, which is markdown already, answers as markdown, and an .md path that names no page isn't taken", async () => {
    const start = await get('/start.md');
    expect(start.status).toBe(200);
    expect(start.headers.get('content-type')).toBe('text/markdown; charset=utf-8');

    expect((await get('/nothing-here.md')).headers.get('content-type')).not.toContain('markdown');
  });

  test('a page asked for without Accept: text/markdown stays HTML, and one that ranks HTML first gets HTML', async () => {
    const plain = await get('/projects');
    const htmlFirst = await get('/projects', { headers: { accept: 'text/html, text/markdown;q=0.5' } });
    const mdFirst = await get('/projects', { headers: { accept: 'text/markdown, text/html;q=0.5' } });

    expect(plain.headers.get('content-type')).toContain('text/html');
    expect(htmlFirst.headers.get('content-type')).toContain('text/html');
    expect(mdFirst.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  test("a project's markdown shows what its page shows: its issues, its rules, and how it got in, with the policy's quote and link", async () => {
    const listed = 'sample-owner/sample-listed';
    await policyListing(listed);
    await tag(listed, `${listed}#4`, 'Crash on empty input');

    const res = await get(`/${listed}.md`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toBe(`<${ORIGIN}/${listed}>; rel="canonical"`);
    expect(body).toContain(`[Crash on empty input](${ORIGIN}/${listed}/issues/4)`);
    expect(body).toContain('> “Agent pull requests are welcome on issues labeled help wanted.”');
    expect(body).toContain(`(${POLICY.url})`);
    expect(body).toContain('PRs: reviewed');
  });
});

describe('what a page hides, its markdown hides, with the same status', () => {
  test("a pending, rejected, delisted, or do-not-listed project's markdown is 404 as its page is, and shows nothing cached from its repo", async () => {
    const cases: [string, () => Promise<void>][] = [
      ['sample-owner/sample-pending', async () => {
        await setProjectStatus(db, 'sample-owner/sample-pending', { status: 'pending', reason: null, changedBy: admin.githubId }, t0);
      }],
      ['sample-owner/sample-rejected', async () => {
        await setProjectStatus(db, 'sample-owner/sample-rejected', { status: 'rejected', reason: 'No tests.', changedBy: admin.githubId }, t0);
      }],
      ['sample-owner/sample-delisted', async () => {
        await setDelisted(db, 'sample-owner/sample-delisted', 'GitHub shows no public repo named sample-owner/sample-delisted.', t0);
      }],
      ['sample-owner/sample-removed', async () => {
        await addToDoNotList(db, { repo: 'sample-owner/sample-removed', reason: null, addedBy: admin.githubId }, t0);
      }],
    ];
    for (const [name, hide] of cases) {
      await registeredProject({ tags: ['help wanted'] }, name);
      await tag(name, `${name}#1`, 'A title only the page could show');
      await hide();

      const page = await get(`/${name}`);
      const markdown = await get(`/${name}.md`);
      const issue = await get(`/${name}/issues/1.md`);

      expect(page.status, name).toBe(404);
      expect(markdown.status, name).toBe(404);
      expect(await markdown.text(), name).toContain("isn't listed on Good First Token");
      expect(await issue.text(), name).not.toContain('A title only the page could show');
    }
  });

  test("a blocked donor's markdown is 404 with the same words as a login no one signed in with", async () => {
    await blockDonor(db, { githubId: kenji.githubId, reason: 'posted spam', blockedBy: admin.githubId }, t0);

    const blocked = await get('/@kenji.md');
    const nobody = await get('/@nobody-here.md');

    expect(blocked.status).toBe(404);
    expect((await get('/@kenji')).status).toBe(404);
    expect((await blocked.text()).replace('kenji', 'X')).toBe((await nobody.text()).replace('nobody-here', 'X'));
  });

  test('when the database is down, the markdown says so with 503, as the page does', async () => {
    await registeredProject();
    databaseDown();

    for (const path of ['/projects', '/leaderboard', `/${repo}`]) {
      const res = await get(md(path));
      expect(res.status, path).toBe(503);
      expect(await res.text(), path).toContain("can't be read right now");
    }
  });

  test("/me.md and /admin.md send someone signed out to sign in, /admin.md is 404 for someone who isn't an admin, and neither is cached", async () => {
    for (const path of ['/me', '/admin']) {
      const page = await get(path);
      const markdown = await get(`${path}.md`);
      expect(markdown.status, path).toBe(page.status);
      expect(new URL(markdown.headers.get('location') ?? '', ORIGIN).pathname, path).toBe('/sign-in');
    }

    const github = startGitHub();
    const browser = new Browser();
    await signInOnGitHub(browser, github, 'priya');
    const me = await browser.fetch('/me.md');
    const notAdmin = await browser.fetch('/admin.md');

    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(await me.text()).toContain('# Your queue');
    expect(notAdmin.status).toBe(404);
    expect(notAdmin.headers.get('cache-control')).toBe('no-store');
    vi.unstubAllGlobals();
  });
});

/** Markdown as a GitHub-flavored renderer draws it, with raw HTML let through, so any that got in shows. */
function render(markdown: string): string {
  return micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()], allowDangerousHtml: true });
}

// Text from GitHub or an agent that would add to a markdown page, if it
// weren't escaped. Each is made up.
const ATTACKS = [
  '# Heading from a title',
  '[click me](https://evil.example/link)',
  '![an image](https://evil.example/image.png)',
  '<img src="https://evil.example/tag.png">',
  'see www.evil.example/www for details',
  'raw https://evil.example/raw link',
  'mail someone@evil.example now',
  '1. a numbered item',
  '- a bullet item',
  '> a quote',
  '| a | table |',
  '`code` and **bold** and _em_ and ~~gone~~',
  '[ref]: https://evil.example/ref',
  '<https://evil.example/angle>',
  'two\n# lines',
];

describe('text from GitHub or an agent adds nothing to the markdown', () => {
  test('an issue title, a label, notes for agents, a policy quote, and an agent line add no heading, link, image, or HTML', async () => {
    const attack = ATTACKS.join(' ');
    const listed = 'sample-owner/sample-listed';
    await policyListing(listed, { ...POLICY, quote: attack.slice(0, 2000) });
    await registeredProject({ tags: ['help wanted', '[x](https://evil.example/tag)'], agentNotes: attack });
    let n = 0;
    for (const title of ATTACKS) {
      n += 1;
      await tag(repo, `${repo}#${String(n)}`, title, ['help wanted', title.slice(0, 50)]);
    }
    await claimWithLine(`${repo}#1`, ATTACKS.join(' ').slice(0, 190));
    await homeFeed(env.FEED).deliver(
      ATTACKS.map((text, i): { event: FeedEvent; githubId: number } => ({
        event: {
          id: `e_readable${String(i).padStart(14, '0')}`,
          time: new Date(t0 + i * 1000).toISOString(),
          user: 'priya',
          agent: 'claude-code',
          issue: `${repo}#1`,
          claim: 'c_readable000000000001',
          kind: 'update',
          job: '[job](https://evil.example/job)',
          text: text.replaceAll('\n', ' '),
        },
        githubId: priya.githubId,
      })),
    );

    for (const path of [`/${repo}`, `/${listed}`, `/${repo}/issues/1`, `/${repo}/issues/2`, '/live', '/', '/projects']) {
      const res = await get(md(path));
      expect(res.status, path).toBe(200);
      const html = render(await res.text());

      // No image, HTML, table, or emphasis, and no heading, list item, or
      // quote that starts with the words of an attack.
      expect(html, path).not.toMatch(/<img|<script|<table|<del>|<strong>|<em>|<code>code<\/code>/i);
      expect(html, path).not.toMatch(/<h\d>(Heading from a title|lines)/);
      expect(html, path).not.toMatch(/<li>(a numbered item|a bullet item)/);
      expect(html, path).not.toMatch(/<blockquote>\s*<p>a quote/);
      const hrefs = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((match) => new URL(match[1] ?? '').host);
      expect(new Set(hrefs), path).toEqual(new Set(hrefs.filter((host) => host === 'primary.example' || host === 'github.com')));
    }

    // The words still read as they were written.
    const issue = render(await (await get(`/${repo}/issues/2.md`)).text());
    expect(issue).toContain('<h1>[click me](https://evil.example/link)</h1>');
  });
});

describe('page metadata', () => {
  /** The attributes of each tag in the page's head, like meta and link. */
  function headTags(html: string, name: 'meta' | 'link'): Record<string, string>[] {
    const head = html.slice(0, html.indexOf('</head>'));
    return [...head.matchAll(new RegExp(`<${name} ([^>]*)/?>`, 'g'))].map((tag) =>
      Object.fromEntries([...(tag[1] ?? '').matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map((a) => [a[1] ?? '', a[2] ?? ''])),
    );
  }

  function metaContent(html: string, key: string): string | undefined {
    return headTags(html, 'meta').find((tag) => tag.name === key || tag.property === key)?.content;
  }

  test('each public page names its canonical URL on the primary domain, whatever host served it, with its Open Graph tags and markdown version', async () => {
    await registeredProject();
    await tag(repo, `${repo}#12`);
    const cards: Record<string, string> = { [`/${repo}`]: `/${repo}/card.png`, [`/${repo}/issues/12`]: `/${repo}/issues/12/card.png`, '/@priya': '/@priya/card.png' };
    for (const path of ['/', '/projects', '/leaderboard', '/live', '/maintainers', `/${repo}`, `/${repo}/issues/12`, '/@priya']) {
      const html = await (await get(path)).text();
      const links = headTags(html, 'link');
      const url = `${ORIGIN}${path}`;

      expect(links.find((link) => link.rel === 'canonical')?.href, path).toBe(url);
      expect(links.find((link) => link.rel === 'alternate' && link.type === 'text/markdown')?.href, path).toBe(`${ORIGIN}${md(path)}`);
      expect(metaContent(html, 'og:url'), path).toBe(url);
      expect(metaContent(html, 'og:title'), path).toBeTruthy();
      expect(metaContent(html, 'og:description'), path).toBe(metaContent(html, 'description'));
      expect(metaContent(html, 'description'), path).toBeTruthy();
      // A page with a card of its own names it, and the rest the default card.
      expect(metaContent(html, 'og:image'), path).toBe(`${ORIGIN}${cards[path] ?? '/card.png'}`);
    }
  });

  test("a project's canonical URL is its repo as saved, however the path spells it, and a page that isn't there has none and asks not to be indexed", async () => {
    await registeredProject();

    const upper = await (await get('/SAMPLE-OWNER/SAMPLE-APP')).text();
    const missing = await (await get('/sample-owner/not-a-project')).text();

    expect(headTags(upper, 'link').find((link) => link.rel === 'canonical')?.href).toBe(`${ORIGIN}/${repo}`);
    expect(headTags(missing, 'link').find((link) => link.rel === 'canonical')).toBeUndefined();
    expect(metaContent(missing, 'robots')).toBe('noindex');
  });
});

/** Whether robots.txt lets a crawler fetch `path`, by the longest rule that matches, with `*` and `$`, as the big crawlers read it. */
function allowed(robots: string, path: string): boolean {
  let best = { length: -1, allow: true };
  for (const line of robots.split('\n')) {
    const found = /^(Allow|Disallow):\s*(\S*)$/.exec(line.trim());
    if (!found?.[2]) continue;
    const rule = found[2];
    const anchored = rule.endsWith('$');
    const body = anchored ? rule.slice(0, -1) : rule;
    const pattern = new RegExp(`^${body.replace(/[.+?^{}()|[\]\\$]/g, '\\$&').replace(/\*/g, '.*')}${anchored ? '$' : ''}`);
    if (pattern.test(path) && rule.length > best.length) best = { length: rule.length, allow: found[1] === 'Allow' };
  }
  return best.allow;
}

describe('robots.txt, the sitemap, and llms.txt', () => {
  test('robots.txt keeps crawlers off the signed-in pages, sign-in steps, and hour-long streams, and on every other page, with the sitemap on the primary domain', async () => {
    const res = await get('/robots.txt');
    const robots = await res.text();

    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    for (const path of ['/', '/projects', '/index.md', `/${repo}`, `/${repo}.md`, '/meanwhileso/goodfirsttoken', '/@priya', '/admin-tools/repo', '/mcpx/repo', '/llms.txt', '/projects.json']) {
      expect(allowed(robots, path), path).toBe(true);
    }
    for (const path of ['/me', '/me.md', '/admin', '/admin?after=x', '/auth/sign-in', '/oauth/authorize', '/mcp', '/live.txt', `/${repo}/live.ndjson`, '/@priya/live.txt?since=e_1']) {
      expect(allowed(robots, path), path).toBe(false);
    }
  });

  test('the sitemap lists the public pages and each project with a page, on the primary domain, and nothing else', async () => {
    await registeredProject();
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-paused');
    await setProjectStatus(db, 'sample-owner/sample-paused', { status: 'paused', reason: null, changedBy: admin.githubId }, t0);
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-pending');
    await setProjectStatus(db, 'sample-owner/sample-pending', { status: 'pending', reason: null, changedBy: admin.githubId }, t0);
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-removed');
    await addToDoNotList(db, { repo: 'sample-owner/sample-removed', reason: null, addedBy: admin.githubId }, t0);

    const res = await get('/sitemap.xml');
    const locs = [...(await res.text()).matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);

    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(locs).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/projects`,
      `${ORIGIN}/leaderboard`,
      `${ORIGIN}/live`,
      `${ORIGIN}/maintainers`,
      `${ORIGIN}/${repo}`,
      `${ORIGIN}/sample-owner/sample-paused`,
    ]);
    for (const loc of locs) expect((await get(new URL(loc ?? '').pathname)).status, loc).toBe(200);
  });

  test('llms.txt points to /start.md, the MCP server, the skills, the JSON data, and the streams, and every site link in it answers', async () => {
    await registeredProject();
    const res = await get('/llms.txt');
    const llms = await res.text();

    expect(res.status).toBe(200);
    expect(llms.startsWith('# Good First Token\n')).toBe(true);
    for (const part of [`${ORIGIN}/start.md`, `${ORIGIN}/mcp`, 'npx skills add meanwhileso/goodfirsttoken', `${ORIGIN}/projects.json`, `${ORIGIN}/live.txt`, 'CC0-1.0']) {
      expect(llms).toContain(part);
    }
    const links = [...llms.matchAll(new RegExp(`${ORIGIN}(/[^\\s)]*)`, 'g'))]
      .map((match) => (match[1] ?? '').replace(/[.,:]$/, ''))
      .filter((path) => !path.includes('<') && path !== '/mcp' && !path.endsWith('.txt') && !path.endsWith('/'));
    expect(links.length).toBeGreaterThan(5);
    for (const path of links) expect((await get(path)).status, path).toBe(200);
  });
});

describe('the JSON data', () => {
  test('/projects.json lists exactly the projects with a page, each matching the schema, under CC0, with how each got in', async () => {
    await registeredProject({ tags: ['help wanted'], prMode: 'automatic' });
    await policyListing('sample-owner/sample-listed');
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-paused');
    await setProjectStatus(db, 'sample-owner/sample-paused', { status: 'paused', reason: 'Busy.', changedBy: maintainer.githubId }, t0);
    for (const [name, status] of [['sample-owner/sample-pending', 'pending'], ['sample-owner/sample-rejected', 'rejected']] as const) {
      await registeredProject({ tags: ['help wanted'] }, name);
      await setProjectStatus(db, name, { status, reason: status === 'rejected' ? 'No tests.' : null, changedBy: admin.githubId }, t0);
    }
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-delisted');
    await setDelisted(db, 'sample-owner/sample-delisted', 'GitHub shows no public repo named sample-owner/sample-delisted.', t0);
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-removed');
    await addToDoNotList(db, { repo: 'sample-owner/sample-removed', reason: null, addedBy: admin.githubId }, t0);

    const res = await get('/projects.json');
    const body = await res.json<{ license: string; total: number; next: unknown; projects: { repo: string }[] }>();

    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(openProjectsFileSchema.safeParse(body).success).toBe(true);
    for (const record of body.projects) expect(openProjectSchema.safeParse(record).success, record.repo).toBe(true);
    expect(body.license).toBe('CC0-1.0');
    expect(body.total).toBe(3);
    expect(body.next).toBeNull();
    expect(body.projects).toEqual([
      expect.objectContaining({ repo, status: 'approved', source: 'registered', policy: null }),
      expect.objectContaining({ repo: 'sample-owner/sample-listed', source: 'policy', policy: { quote: POLICY.quote, url: POLICY.url } }),
      expect.objectContaining({ repo: 'sample-owner/sample-paused', status: 'paused' }),
    ]);
    expect(body.projects[0]).toMatchObject({
      settings: { prMode: 'automatic' },
      links: { page: `${ORIGIN}/${repo}`, markdown: `${ORIGIN}/${repo}.md`, json: `${ORIGIN}/${repo}.json`, live: `${ORIGIN}/${repo}/live.txt` },
    });
  });

  test("/<owner>/<repo>.json is the project's record, found without case, and 404 for a repo with no page", async () => {
    await policyListing('sample-owner/sample-listed');
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/sample-pending');
    await setProjectStatus(db, 'sample-owner/sample-pending', { status: 'pending', reason: null, changedBy: admin.githubId }, t0);

    const found = await get('/SAMPLE-OWNER/sample-listed.json');
    const body: unknown = await found.json();
    const pending = await get('/sample-owner/sample-pending.json');
    const none = await get('/sample-owner/nothing.json');
    const site = await get('/admin/anything.json');

    expect(found.status).toBe(200);
    expect(openProjectFileSchema.parse(body).project).toMatchObject({ repo: 'sample-owner/sample-listed', source: 'policy' });
    expect([pending.status, none.status, site.status]).toEqual([404, 404, 404]);
    expect(await pending.json()).toEqual(await none.json());
  });

  test('the list comes a page at a time, by repo, each page linking the next, and the last linking none', async () => {
    for (const name of ['sample-owner/c-app', 'sample-owner/a-app', 'sample-owner/b-app']) {
      await registeredProject({ tags: ['help wanted'] }, name);
    }

    const first = await loadProjectsFile(ORIGIN, null, 2);
    if (first.state !== 'ready') throw new Error(first.state);
    expect(first.file.projects.map((p) => p.repo)).toEqual(['sample-owner/a-app', 'sample-owner/b-app']);
    expect(first.file.total).toBe(3);
    expect(first.file.next).toBe(`${ORIGIN}/projects.json?after=sample-owner%2Fb-app`);

    const next = await get(new URL(first.file.next ?? '').pathname + new URL(first.file.next ?? '').search);
    const rest = await next.json<{ projects: { repo: string }[]; next: unknown; total: number }>();
    expect(rest.projects.map((p) => p.repo)).toEqual(['sample-owner/c-app']);
    expect(rest.next).toBeNull();
    expect(rest.total).toBe(3);

    expect((await get('/projects.json?after=not a repo')).status).toBe(400);
  });
});
