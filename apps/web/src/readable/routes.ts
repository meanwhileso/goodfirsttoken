import { githubLogin, validate } from '@goodfirsttoken/core';
import { loadAdminPage } from '../admin/page';
import { siteOrigin } from '../auth/settings';
import { loadHome } from '../home/load';
import { issueFromPath, loadIssue } from '../issue/load';
import { ownedBySite, repoFromPath } from '../issue/path';
import { loadLeaderboard } from '../leaderboard/load';
import { loadLive } from '../live/load';
import { loadMePage } from '../me/page';
import { loadPerson } from '../person/load';
import { loadProject, loadProjectsList } from '../project/load';
import { loadProjectFile, loadProjectsFile } from './data';
import { llmsTxt, robotsTxt, sitemapXml } from './discovery';
import { markdownPath } from './head';
import {
  adminMarkdown,
  designMarkdown,
  homeMarkdown,
  issueMarkdown,
  leaderboardMarkdown,
  liveMarkdown,
  maintainersMarkdown,
  meMarkdown,
  notFoundMarkdown,
  personMarkdown,
  projectMarkdown,
  projectsMarkdown,
  signInMarkdown,
} from './pages';

// The site in the forms agents read (spec section 9, "Readable by agents"):
// each page's markdown version, at its path plus `.md` or at its own path
// with `Accept: text/markdown`, and /llms.txt, /robots.txt, /sitemap.xml,
// /projects.json, and /<owner>/<repo>.json. src/server.ts sends a request
// here when readableRoute finds one for it, and every other request to
// TanStack Start as before. Each markdown version reads its page's own
// loader, so it shows what the page shows, and hides what the page hides,
// with the same status.

type Params = Record<string, string>;

/** A page's markdown version: the route it belongs to, the paths it answers, and how. */
interface MarkdownRoute {
  /** The TanStack Router route ID of the page, as in src/routeTree.gen.ts. */
  route: string;
  /** The page's path, with its parameters, or null when this route doesn't take the path. */
  match: (path: string) => Params | null;
  answer: (request: Request, params: Params) => Promise<Response>;
}

const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

// Every public answer is the same for everyone, so any page may read it.
// Public pages set no Cache-Control, and neither do these. The page's
// markdown and HTML share a URL under Accept, so caches keep them apart.
const PUBLIC = {
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  vary: 'Accept',
};

function markdown(status: number, body: string, canonical: string | null = null): Response {
  const headers: Record<string, string> = { 'content-type': MARKDOWN_TYPE, ...PUBLIC };
  // The HTML page is the one search engines list.
  if (canonical !== null) headers.link = `<${canonical}>; rel="canonical"`;
  return new Response(body, { status, headers });
}

/** A signed-in page's markdown: never cached, with any cookie sign-in refreshed. */
function privateMarkdown(body: string, setCookies: readonly string[], status = 200): Response {
  const headers = new Headers({ 'content-type': MARKDOWN_TYPE, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(body, { status, headers });
}

/** Someone signed out, sent to sign in, as the page sends them. */
function toSignIn(origin: string, setCookies: readonly string[]): Response {
  const headers = new Headers({ location: `${origin}/sign-in`, 'cache-control': 'no-store' });
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 307, headers });
}

/** A route for a path with no parameters. */
function fixed(route: string, answer: (request: Request) => Promise<Response>): MarkdownRoute {
  return { route, match: (path) => (path === route ? {} : null), answer };
}

function page(origin: string, path: string): string {
  return `${origin}${path}`;
}

const UNAVAILABLE = 503;

/** Every page's markdown version, the fixed paths first. */
export const MARKDOWN_ROUTES: readonly MarkdownRoute[] = [
  fixed('/', async (request) => {
    const origin = siteOrigin(request);
    return markdown(200, homeMarkdown(origin, await loadHome(request)), page(origin, '/'));
  }),
  fixed('/projects', async (request) => {
    const origin = siteOrigin(request);
    const list = await loadProjectsList();
    return markdown(list.state === 'ready' ? 200 : UNAVAILABLE, projectsMarkdown(origin, list), page(origin, '/projects'));
  }),
  fixed('/leaderboard', async (request) => {
    const origin = siteOrigin(request);
    const board = await loadLeaderboard();
    return markdown(board.state === 'ready' ? 200 : UNAVAILABLE, leaderboardMarkdown(origin, board), page(origin, '/leaderboard'));
  }),
  fixed('/live', async (request) => {
    const origin = siteOrigin(request);
    return markdown(200, liveMarkdown(origin, await loadLive(request)), page(origin, '/live'));
  }),
  fixed('/maintainers', (request) => {
    const origin = siteOrigin(request);
    return Promise.resolve(markdown(200, maintainersMarkdown(origin), page(origin, '/maintainers')));
  }),
  fixed('/design', (request) => {
    const origin = siteOrigin(request);
    return Promise.resolve(markdown(200, designMarkdown(origin), page(origin, '/design')));
  }),
  fixed('/sign-in', (request) => {
    const origin = siteOrigin(request);
    return Promise.resolve(markdown(200, signInMarkdown(origin), page(origin, '/sign-in')));
  }),
  fixed('/me', async (request) => {
    const origin = siteOrigin(request);
    const { result, setCookies } = await loadMePage(request, {});
    if (result.state === 'signed_out') return toSignIn(origin, setCookies);
    return privateMarkdown(meMarkdown(origin, result.page), setCookies);
  }),
  fixed('/admin', async (request) => {
    const origin = siteOrigin(request);
    const { result, setCookies } = await loadAdminPage(request, {});
    if (result.state === 'signed_out') return toSignIn(origin, setCookies);
    if (result.state === 'not_found') return privateMarkdown(notFoundMarkdown('Not found', 'There is no page at this address.'), setCookies, 404);
    return privateMarkdown(adminMarkdown(origin, result.page), setCookies);
  }),
  {
    route: '/@{$user}',
    match: (path) => {
      const found = /^\/@([^/]+)$/.exec(path);
      return found ? { user: found[1] ?? '' } : null;
    },
    answer: async (request, { user = '' }) => {
      const origin = siteOrigin(request);
      const person = await loadPerson(request, user);
      if (person.state === 'ready') return markdown(200, personMarkdown(origin, person), page(origin, `/@${person.login}`));
      if (person.state === 'unavailable') {
        return markdown(UNAVAILABLE, notFoundMarkdown(`@${person.login}`, "This page can't be read right now. Try again in a moment."));
      }
      // A login no one signed in with, or a blocked donor, reads the same.
      const login = validate(githubLogin, user).ok ? user : null;
      return markdown(
        404,
        notFoundMarkdown('Not found', login === null ? 'There is no page at this address.' : `@${login} has no page on Good First Token.`),
      );
    },
  },
  {
    route: '/$owner/$repo/issues/$number',
    match: (path) => {
      const found = /^\/([^/]+)\/([^/]+)\/issues\/([^/]+)$/.exec(path);
      return found ? { owner: found[1] ?? '', repo: found[2] ?? '', number: found[3] ?? '' } : null;
    },
    answer: async (request, { owner = '', repo = '', number = '' }) => {
      const origin = siteOrigin(request);
      const issue = await loadIssue(request, owner, repo, number);
      if (issue.state === 'ready') {
        return markdown(200, issueMarkdown(origin, issue), page(origin, `/${issue.repo}/issues/${String(issue.number)}`));
      }
      if (issue.state === 'unavailable') {
        return markdown(UNAVAILABLE, notFoundMarkdown(issue.issue, "This issue can't be read right now. Try again in a moment."));
      }
      const named = issueFromPath(owner, repo, number);
      return markdown(
        404,
        named === null
          ? notFoundMarkdown('Not found', 'There is no issue page at this address.')
          : notFoundMarkdown('Not on Good First Token', `No project on Good First Token tagged ${named}, and no one has claimed it.`),
      );
    },
  },
  {
    route: '/$owner/$repo/',
    match: (path) => {
      const found = /^\/([^/@][^/]*)\/([^/]+)\/?$/.exec(path);
      return found ? { owner: found[1] ?? '', repo: found[2] ?? '' } : null;
    },
    answer: async (request, { owner = '', repo = '' }) => {
      const origin = siteOrigin(request);
      const project = await loadProject(request, owner, repo);
      if (project.state === 'ready') return markdown(200, projectMarkdown(origin, project), page(origin, `/${project.repo}`));
      if (project.state === 'unavailable') {
        return markdown(UNAVAILABLE, notFoundMarkdown(project.repo, "This project can't be read right now. Try again in a moment."));
      }
      const named = repoFromPath(owner, repo);
      return markdown(
        404,
        named === null
          ? notFoundMarkdown('Not found', 'There is no project page at this address.')
          : notFoundMarkdown(
              'Not on Good First Token',
              `${named} isn't listed on Good First Token. Maintainers add theirs from their agent: ${origin}/maintainers.md`,
            ),
      );
    },
  },
];

/**
 * The route IDs of pages with no markdown version, and why. A test checks
 * that every page in the route tree is in MARKDOWN_ROUTES or here.
 */
export const NO_MARKDOWN: Readonly<Record<string, string>> = {
  '/oauth/authorize':
    "A step in an agent's sign-in, for the person in a browser. The agent never reads it, and its page is for that one request.",
};

/**
 * Whether the request asks for markdown by its Accept header: it names
 * text/markdown, and ranks it above text/html, or leaves text/html out.
 */
export function wantsMarkdown(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (accept === null) return false;
  const ranks = new Map<string, number>();
  for (const part of accept.split(',')) {
    const [type = '', ...params] = part.split(';').map((piece) => piece.trim().toLowerCase());
    const q = params.find((param) => param.startsWith('q='));
    const rank = q === undefined ? 1 : Number(q.slice(2));
    ranks.set(type, Number.isFinite(rank) ? rank : 0);
  }
  const md = ranks.get('text/markdown') ?? 0;
  return md > 0 && md > (ranks.get('text/html') ?? 0);
}

/** The page path a request for a markdown version names, or null when it asks for none. */
function markdownRequest(request: Request, url: URL): string | null {
  const path = url.pathname;
  if (path.endsWith('.md')) {
    const base = path.slice(0, -'.md'.length);
    return base === '/index' || base === '' ? '/' : base;
  }
  // A path under an owner whose paths belong to the site, like
  // /oauth/authorize or /dev/seed, keeps its own answer whatever it accepts.
  const owner = /^\/([^/]+)\//.exec(path)?.[1];
  if (owner !== undefined && ownedBySite(owner)) return null;
  return wantsMarkdown(request) ? path : null;
}

function json(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' },
  });
}

function plain(status: number, body: string, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': type, 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', ...extra },
  });
}

// /llms.txt and /robots.txt change only with a deploy, as /start.md does
// (src/start/start.ts), so they take its five minutes of caching.
const STATIC = { 'cache-control': 'public, max-age=300' };

async function projectsJson(request: Request, url: URL): Promise<Response> {
  const result = await loadProjectsFile(siteOrigin(request), url.searchParams.get('after'));
  if (result.state === 'bad_after') return json(400, { error: 'bad_request', message: 'after must be a repo, as owner/name.' });
  if (result.state === 'unavailable') return json(UNAVAILABLE, { error: 'unavailable', message: "The projects can't be read right now." });
  return json(200, result.file);
}

async function projectJson(request: Request, owner: string, repo: string): Promise<Response> {
  const result = await loadProjectFile(siteOrigin(request), owner, repo);
  if (result.state === 'not_found') return json(404, { error: 'not_found', message: 'No project with a page on Good First Token has this repo.' });
  if (result.state === 'unavailable') return json(UNAVAILABLE, { error: 'unavailable', message: "The project can't be read right now." });
  return json(200, result.file);
}

type Answer = () => Promise<Response>;

/**
 * What answers the request, when it is for one of the forms above and uses
 * GET or HEAD, or null for TanStack Start. A `.md` path that names no page,
 * like /start.md, goes on to the rest of the site too.
 */
export function readableRoute(request: Request): Answer | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  const path = url.pathname;
  const origin = siteOrigin(request);
  switch (path) {
    case '/llms.txt':
      return () => Promise.resolve(plain(200, llmsTxt(origin), undefined, STATIC));
    case '/robots.txt':
      return () => Promise.resolve(plain(200, robotsTxt(origin), undefined, STATIC));
    case '/sitemap.xml':
      return async () => {
        const body = await sitemapXml(origin);
        return body === null ? plain(UNAVAILABLE, "The sitemap can't be read right now.\n") : plain(200, body, 'application/xml; charset=utf-8');
      };
    case '/projects.json':
      return () => projectsJson(request, url);
  }
  const data = /^\/([^/@][^/]*)\/([^/]+)\.json$/.exec(path);
  if (data) return () => projectJson(request, data[1] ?? '', data[2] ?? '');

  const asked = markdownRequest(request, url);
  if (asked === null) return null;
  for (const route of MARKDOWN_ROUTES) {
    const params = route.match(asked);
    if (params !== null) return () => route.answer(request, params);
  }
  return null;
}

/** Answers the request as readableRoute found, with no body for HEAD. */
export async function handleReadable(request: Request, answer: Answer): Promise<Response> {
  const response = await answer();
  return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export { markdownPath };
