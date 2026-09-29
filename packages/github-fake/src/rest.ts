// The REST endpoints the app calls. Each route names its docs page, and
// errors send that page back as documentation_url, the way GitHub does.

import { lookupPath, readObject, type Oid } from './git.ts';
import { REST_DOCS, errorResponse, json, paginate } from './http.ts';
import { own, setOwn } from './own.ts';
import { searchIssues, searchRepos } from './search.ts';
import {
  blobShape,
  branchShape,
  compareShape,
  contentShape,
  fullUserShape,
  issueShape,
  labelShape,
  pullShape,
  refShape,
  repoShape,
  reviewCommentShape,
  reviewShape,
  timelineEventShape,
  type Ctx,
} from './shapes.ts';
import {
  FakeError,
  canSee,
  findIssue,
  findRepo,
  findRepoById,
  forkOf,
  forkRepo,
  fullName,
  getPull,
  key,
  movedRepo,
  newId,
  openPull,
  requireGit,
  requirePush,
  reviewVisible,
  type IssueRecord,
  type PullData,
  type RepoRecord,
} from './state.ts';

export interface RestRequest {
  ctx: Ctx;
  method: string;
  url: URL;
  body: Record<string, unknown>;
  // The OAuth app's client ID and secret, when the call sent them with Basic
  // authentication.
  app?: { clientId: string; clientSecret: string } | null;
  now: string;
  // When a fork made by this call has its git data, since GitHub makes it
  // in the background. `now` makes it ready at once.
  forkReadyAt?: string;
}

type Params = Record<string, string>;

interface Route {
  method: string;
  // {name} matches one path segment, {name+} matches the rest of the path.
  path: string;
  docs: string;
  auth?: boolean;
  handle: (req: RestRequest, params: Params) => Response;
}

const DOCS = 'https://docs.github.com/en/rest';

// A repo the call can't see answers 404, like one that isn't there.
function repoOf(req: RestRequest, params: Params): RepoRecord {
  const repo = findRepo(req.ctx.state, params.owner ?? '', params.repo ?? '');
  if (!repo || !canSee(repo, req.ctx.viewer, req.ctx.scopes)) throw new FakeError('not_found', 'Not Found');
  return repo;
}

function visibleTo(req: RestRequest) {
  return (repo: RepoRecord) => canSee(repo, req.ctx.viewer, req.ctx.scopes);
}

function issueOf(repo: RepoRecord, params: Params): IssueRecord {
  const issue = findIssue(repo, Number(params.issue_number));
  if (!issue) throw new FakeError('not_found', 'Not Found');
  return issue;
}

function viewer(req: RestRequest): string {
  if (req.ctx.viewer === null) throw new FakeError('forbidden', 'Requires authentication');
  return req.ctx.viewer;
}

function list<T>(req: RestRequest, items: T[], shape: (item: T) => unknown): Response {
  const page = paginate(req.url, items);
  return json(page.items.map(shape), 200, page.headers);
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const byDate = (field: 'createdAt' | 'updatedAt', direction: string) => (a: IssueRecord, b: IssueRecord) =>
  (Date.parse(a[field]) - Date.parse(b[field]) || a.number - b.number) * (direction === 'asc' ? 1 : -1);

// GitHub serves the first 1,000 results of any search, and refuses a page
// that starts past them.
function searchPage<T>(
  req: RestRequest,
  results: T[],
  shape: (item: T) => unknown,
  extra: Record<string, unknown> = {},
): Response {
  const page = paginate(req.url, results.slice(0, 1000));
  if (page.start >= 1000) throw new FakeError('invalid', 'Only the first 1000 search results are available');
  return json(
    { total_count: results.length, incomplete_results: false, ...extra, items: page.items.map(shape) },
    200,
    page.headers,
  );
}

// One side of a comparison: a branch or a commit in the repo, or
// USERNAME:BRANCH in that person's fork of it.
function resolveSide(req: RestRequest, repo: RepoRecord, side: string): Oid {
  const colon = side.indexOf(':');
  if (colon === -1) return resolveRef(repo, side, req);
  const owner = side.slice(0, colon);
  const where = key(owner) === key(repo.owner) ? repo : forkOf(req.ctx.state, repo, owner);
  if (!where || !canSee(where, req.ctx.viewer, req.ctx.scopes)) throw new FakeError('not_found', 'Not Found');
  requireGit(where, req.now);
  return resolveRef(where, side.slice(colon + 1), req);
}

function resolveRef(repo: RepoRecord, ref: string | null, req: RestRequest): Oid {
  const name = ref ?? repo.defaultBranch;
  const sha = own(repo.branches, name.replace(/^refs\/heads\//, ''));
  if (sha !== undefined) return sha;
  if (own(req.ctx.state.objects, name)?.type === 'commit') return name;
  throw new FakeError('not_found', `No commit found for the ref ${name}`);
}

const routes: Route[] = [
  {
    method: 'GET',
    path: '/user',
    docs: `${DOCS}/users/users#get-the-authenticated-user`,
    auth: true,
    handle: (req) => json(fullUserShape(req.ctx, viewer(req), true)),
  },
  {
    // An OAuth app revokes one of its own tokens, with its client ID and
    // secret as Basic authentication and the token in the body. The fake
    // answers 404 when those credentials are wrong or the app didn't issue
    // the token, and the token keeps working.
    method: 'DELETE',
    path: '/applications/{client_id}/token',
    docs: `${DOCS}/apps/oauth-applications#delete-an-app-token`,
    handle: (req, params) => {
      const app = own(req.ctx.state.oauthApps, params.client_id ?? '');
      if (!app || req.app?.clientId !== app.clientId || req.app.clientSecret !== app.clientSecret) {
        throw new FakeError('not_found', 'Not Found');
      }
      const token = str(req.body.access_token);
      if (!token) {
        throw new FakeError('invalid', 'Validation Failed', [
          { resource: 'OauthAccess', code: 'missing_field', field: 'access_token' },
        ]);
      }
      if (own(req.ctx.state.tokens, token)?.clientId !== app.clientId) throw new FakeError('not_found', 'Not Found');
      Reflect.deleteProperty(req.ctx.state.tokens, token);
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'GET',
    path: '/users/{username}',
    docs: `${DOCS}/users/users#get-a-user`,
    handle: (req, params) => {
      const user = fullUserShape(req.ctx, params.username ?? '', false);
      if (!user) throw new FakeError('not_found', 'Not Found');
      return json(user);
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}',
    docs: `${DOCS}/repos/repos#get-a-repository`,
    handle: (req, params) => json(repoShape(req.ctx, repoOf(req, params), true)),
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/labels',
    docs: `${DOCS}/issues/labels#list-labels-for-a-repository`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      return list(req, repo.labels, (label) => labelShape(req.ctx, repo, label));
    },
  },
  {
    // Finds the label without case, the way GitHub matches label names.
    method: 'GET',
    path: '/repos/{owner}/{repo}/labels/{name}',
    docs: `${DOCS}/issues/labels#get-a-label`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      const label = repo.labels.find((l) => key(l.name) === key(params.name ?? ''));
      if (!label) throw new FakeError('not_found', 'Not Found');
      return json(labelShape(req.ctx, repo, label));
    },
  },
  {
    // Needs push access, like every write to a repo.
    method: 'POST',
    path: '/repos/{owner}/{repo}/labels',
    docs: `${DOCS}/issues/labels#create-a-label`,
    auth: true,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      requirePush(repo, viewer(req));
      const name = str(req.body.name);
      const color = str(req.body.color) ?? 'ededed';
      if (!name) throw new FakeError('invalid', 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
      if (!/^[0-9a-f]{6}$/i.test(color)) {
        throw new FakeError('invalid', 'Validation Failed', [{ resource: 'Label', code: 'invalid', field: 'color' }]);
      }
      if (repo.labels.some((l) => key(l.name) === key(name))) {
        throw new FakeError('invalid', 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
      }
      const label = { id: newId(req.ctx.state), name, color: color.toLowerCase(), description: str(req.body.description) ?? null, default: false };
      repo.labels.push(label);
      return json(labelShape(req.ctx, repo, label), 201);
    },
  },
  {
    // Lists pull requests too, each marked with pull_request, as GitHub does.
    method: 'GET',
    path: '/repos/{owner}/{repo}/issues',
    docs: `${DOCS}/issues/issues#list-repository-issues`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      const q = req.url.searchParams;
      const state = q.get('state') ?? 'open';
      const labels = (q.get('labels') ?? '').split(',').map((l) => key(l.trim())).filter(Boolean);
      const assignee = q.get('assignee');
      const creator = q.get('creator');
      const since = q.get('since');
      const issues = Object.values(repo.issues)
        .filter((i) => state === 'all' || i.state === state)
        .filter((i) => labels.every((l) => i.labels.some((name) => key(name) === l)))
        .filter((i) => {
          if (assignee === null) return true;
          if (assignee === '*') return i.assignees.length > 0;
          if (assignee === 'none') return i.assignees.length === 0;
          return i.assignees.some((a) => key(a) === key(assignee));
        })
        .filter((i) => creator === null || key(i.user) === key(creator))
        .filter((i) => since === null || Date.parse(i.updatedAt) >= Date.parse(since))
        .sort(byDate(q.get('sort') === 'updated' ? 'updatedAt' : 'createdAt', q.get('direction') ?? 'desc'));
      return list(req, issues, (issue) => issueShape(req.ctx, repo, issue));
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/issues/{issue_number}',
    docs: `${DOCS}/issues/issues#get-an-issue`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      return json(issueShape(req.ctx, repo, issueOf(repo, params), true));
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/issues/{issue_number}/timeline',
    docs: `${DOCS}/issues/timeline#list-timeline-events-for-an-issue`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      return list(req, issueOf(repo, params).timeline, (event) => timelineEventShape(req.ctx, repo, event));
    },
  },
  {
    method: 'GET',
    path: '/search/issues',
    docs: `${DOCS}/search/search#search-issues-and-pull-requests`,
    handle: (req) => {
      const q = req.url.searchParams.get('q');
      if (!q) throw new FakeError('invalid', 'Validation Failed', [{ resource: 'Search', field: 'q', code: 'missing' }]);
      const sort = req.url.searchParams.get('sort') === 'updated' ? 'updatedAt' : 'createdAt';
      const results = searchIssues(req.ctx.state, q, visibleTo(req)).sort((a, b) =>
        byDate(sort, req.url.searchParams.get('order') ?? 'desc')(a.issue, b.issue),
      );
      // search_type is required here. The fake always searches the lexical way.
      return searchPage(req, results, ({ repo, issue }) => ({ ...issueShape(req.ctx, repo, issue), score: 1 }), {
        search_type: 'lexical',
      });
    },
  },
  {
    method: 'GET',
    path: '/search/repositories',
    docs: `${DOCS}/search/search#search-repositories`,
    handle: (req) => {
      const q = req.url.searchParams.get('q');
      if (!q) throw new FakeError('invalid', 'Validation Failed', [{ resource: 'Search', field: 'q', code: 'missing' }]);
      const sign = req.url.searchParams.get('order') === 'asc' ? 1 : -1;
      const updated = req.url.searchParams.get('sort') === 'updated';
      const results = searchRepos(req.ctx.state, q, visibleTo(req)).sort(
        (a, b) => sign * (updated ? Date.parse(a.updatedAt) - Date.parse(b.updatedAt) : a.stars - b.stars) || a.id - b.id,
      );
      return searchPage(req, results, (repo) => ({ ...repoShape(req.ctx, repo), score: 1 }));
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/contents',
    docs: `${DOCS}/repos/contents#get-repository-content`,
    handle: (req, params) => contents(req, params),
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/contents/{path+}',
    docs: `${DOCS}/repos/contents#get-repository-content`,
    handle: (req, params) => contents(req, params),
  },
  {
    // A person who already has a fork gets it back. GitHub makes a new fork
    // in the background, and its git data answers 409 until it's ready.
    method: 'POST',
    path: '/repos/{owner}/{repo}/forks',
    docs: `${DOCS}/repos/forks#create-a-fork`,
    auth: true,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      const login = viewer(req);
      if (req.body.organization !== undefined) {
        throw new FakeError('invalid', 'The GitHub fake forks into personal accounts only.');
      }
      if (key(repo.owner) === key(login)) {
        throw new FakeError('forbidden', 'You cannot fork a repository you own into the same account.');
      }
      const fork = forkRepo(
        req.ctx.state,
        repo,
        login,
        {
          name: str(req.body.name),
          defaultBranchOnly: req.body.default_branch_only === true,
          readyAt: req.forkReadyAt ?? req.now,
        },
        req.now,
      );
      return json(repoShape(req.ctx, fork, true), 202);
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/branches/{branch+}',
    docs: `${DOCS}/branches/branches#get-a-branch`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      requireGit(repo, req.now);
      const branch = params.branch ?? '';
      const sha = own(repo.branches, branch);
      if (sha === undefined) throw new FakeError('not_found', 'Branch not found');
      return json(branchShape(req.ctx, repo, branch, sha));
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/git/ref/{ref+}',
    docs: `${DOCS}/git/refs#get-a-reference`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      requireGit(repo, req.now);
      const branch = /^heads\/(.+)$/.exec(params.ref ?? '')?.[1];
      const sha = branch === undefined ? undefined : own(repo.branches, branch);
      if (branch === undefined || sha === undefined) throw new FakeError('not_found', 'Not Found');
      return json(refShape(req.ctx, repo, branch, sha));
    },
  },
  {
    // The blob's content, in base64, however large, up to GitHub's 100 MB.
    method: 'GET',
    path: '/repos/{owner}/{repo}/git/blobs/{file_sha}',
    docs: `${DOCS}/git/blobs#get-a-blob`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      requireGit(repo, req.now);
      const sha = params.file_sha ?? '';
      const blob = own(req.ctx.state.objects, sha);
      if (blob?.type !== 'blob') throw new FakeError('not_found', 'Not Found');
      return json(blobShape(req.ctx, repo, sha, blob));
    },
  },
  {
    // BASE...HEAD, each a branch or a commit, and USERNAME:BRANCH for a
    // branch in someone's fork in the same network. The files are the
    // change from the merge base to HEAD.
    method: 'GET',
    path: '/repos/{owner}/{repo}/compare/{basehead+}',
    docs: `${DOCS}/commits/commits#compare-two-commits`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      requireGit(repo, req.now);
      const [base, head, extra] = (params.basehead ?? '').split('...');
      if (base === undefined || head === undefined || extra !== undefined || !base || !head) {
        throw new FakeError('not_found', 'Not Found');
      }
      return json(compareShape(req.ctx, repo, resolveSide(req, repo, base), resolveSide(req, repo, head)));
    },
  },
  {
    // Needs push access. The fake makes branches only, under refs/heads/.
    method: 'POST',
    path: '/repos/{owner}/{repo}/git/refs',
    docs: `${DOCS}/git/refs#create-a-reference`,
    auth: true,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      requirePush(repo, viewer(req));
      requireGit(repo, req.now);
      const ref = str(req.body.ref) ?? '';
      const sha = str(req.body.sha) ?? '';
      const branch = /^refs\/heads\/(.+)$/.exec(ref)?.[1];
      if (branch === undefined) {
        throw new FakeError('invalid', "Reference name must start with 'refs/heads/' in the GitHub fake");
      }
      if (own(req.ctx.state.objects, sha)?.type !== 'commit') throw new FakeError('invalid', 'Object does not exist');
      if (own(repo.branches, branch) !== undefined) throw new FakeError('invalid', 'Reference already exists');
      setOwn(repo.branches, branch, sha);
      return json(refShape(req.ctx, repo, branch, sha), 201);
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/pulls',
    docs: `${DOCS}/pulls/pulls#list-pull-requests`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      const q = req.url.searchParams;
      const state = q.get('state') ?? 'open';
      const head = q.get('head');
      const base = q.get('base');
      const pulls = Object.values(repo.issues)
        .filter((i): i is IssueRecord & { pull: PullData } => i.pull !== null)
        .filter((i) => state === 'all' || i.state === state)
        .filter((i) => head === null || key(`${i.pull.head.owner}:${i.pull.head.ref}`) === key(head))
        .filter((i) => base === null || i.pull.base.ref === base)
        .sort(byDate(q.get('sort') === 'updated' ? 'updatedAt' : 'createdAt', q.get('direction') ?? 'desc'));
      return list(req, pulls, (pull) => pullShape(req.ctx, repo, pull));
    },
  },
  {
    // Opens the PR as the person whose token made the call.
    method: 'POST',
    path: '/repos/{owner}/{repo}/pulls',
    docs: `${DOCS}/pulls/pulls#create-a-pull-request`,
    auth: true,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      if (req.body.issue !== undefined) throw new FakeError('invalid', 'The GitHub fake does not turn issues into PRs.');
      const issue = openPull(
        req.ctx.state,
        repo,
        {
          title: str(req.body.title) ?? '',
          body: str(req.body.body) ?? null,
          head: str(req.body.head) ?? '',
          headRepo: str(req.body.head_repo),
          base: str(req.body.base) ?? '',
          draft: req.body.draft === true,
          maintainerCanModify: req.body.maintainer_can_modify !== false,
          login: viewer(req),
        },
        req.now,
      );
      return json(pullShape(req.ctx, repo, getPull(repo, issue.number), true), 201);
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}',
    docs: `${DOCS}/pulls/pulls#get-a-pull-request`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      return json(pullShape(req.ctx, repo, getPull(repo, Number(params.pull_number)), true));
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews',
    docs: `${DOCS}/pulls/reviews#list-reviews-for-a-pull-request`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      const number = Number(params.pull_number);
      const reviews = getPull(repo, number).pull.reviews.filter((r) => reviewVisible(r, req.ctx.viewer));
      return list(req, reviews, (r) => reviewShape(req.ctx, repo, number, r));
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}/comments',
    docs: `${DOCS}/pulls/comments#list-review-comments-on-a-pull-request`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      const number = Number(params.pull_number);
      const { reviews, reviewComments } = getPull(repo, number).pull;
      // A pending review's comments show only to its author, as the review does.
      const comments = reviewComments.filter((c) => {
        const review = reviews.find((r) => r.id === c.reviewId);
        return review === undefined || reviewVisible(review, req.ctx.viewer);
      });
      if (req.url.searchParams.get('direction') === 'desc') comments.reverse();
      return list(req, comments, (c) => reviewCommentShape(req.ctx, repo, number, c));
    },
  },
];

// A file is returned with its content. A folder is returned as a list of
// its entries.
function contents(req: RestRequest, params: Params): Response {
  const repo = repoOf(req, params);
  requireGit(repo, req.now);
  const ref = req.url.searchParams.get('ref');
  const sha = resolveRef(repo, ref, req);
  const refName = ref ?? repo.defaultBranch;
  const path = params.path ?? '';
  const store = req.ctx.state.objects;
  const found = lookupPath(store, readObject(store, sha, 'commit').tree, path);
  if (!found) throw new FakeError('not_found', 'Not Found');
  if (found.object.type === 'blob') return json(contentShape(req.ctx, repo, refName, path, found.oid, found.object, true));
  // A submodule, which GitHub lists with the type submodule, is left out.
  return json(
    found.object.entries.flatMap((entry) => {
      if (entry.type === 'commit') return [];
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      return [contentShape(req.ctx, repo, refName, entryPath, entry.oid, readObject(store, entry.oid, entry.type), false)];
    }),
  );
}

function match(route: Route, method: string, path: string): Params | null {
  if (route.method !== method) return null;
  const want = route.path.split('/');
  const have = path.split('/');
  const params: Params = {};
  for (let i = 0; i < want.length; i++) {
    const segment = want[i] ?? '';
    const wildcard = /^\{(\w+)(\+?)\}$/.exec(segment);
    if (wildcard?.[2] === '+') {
      const rest = have.slice(i).join('/');
      if (!rest) return null;
      params[wildcard[1] ?? ''] = decodeURIComponent(rest);
      return params;
    }
    const value = have[i];
    if (value === undefined || (wildcard && value === '')) return null;
    if (wildcard) params[wildcard[1] ?? ''] = decodeURIComponent(value);
    else if (segment !== value) return null;
  }
  return want.length === have.length ? params : null;
}

const STATUS = { not_found: 404, forbidden: 403, invalid: 422, stale: 409, empty: 409 };

// The page GitHub's redirect answers name as documentation_url. It says to
// follow redirects, and nothing of which status a call gets.
const REDIRECT_DOCS = 'https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api#follow-redirects';

// A repo's calls, by its ID. GitHub sends a call to a renamed or
// transferred repo's old name here, and it answers as the repo's name now
// does.
const BY_ID = /^\/repositories\/([0-9]+)(\/.*)?$/;
const BY_NAME = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/;

// Where a call to a repo's old name goes: GitHub answers with the repo's ID
// path in Location, and the caller follows it. GitHub's changelog says it
// answers 301 or 307. The split by method, 301 to a read and 307 to
// anything else, is what people observe. Null when the name is a repo's, or
// no repo left it.
// https://developer.github.com/changes/2015-04-17-preview-repository-redirects/
function movedAway(req: RestRequest, path: string): Response | null {
  const named = BY_NAME.exec(path);
  if (!named) return null;
  const [owner = '', name = ''] = [named[1], named[2]].map((part) => decodeURIComponent(part ?? ''));
  if (findRepo(req.ctx.state, owner, name)) return null;
  const repo = movedRepo(req.ctx.state, owner, name);
  if (!repo || !canSee(repo, req.ctx.viewer, req.ctx.scopes)) return null;
  const url = `${req.ctx.apiUrl}/repositories/${String(repo.id)}${named[3] ?? ''}`;
  const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 307;
  const message = status === 301 ? 'Moved Permanently' : 'Temporary Redirect';
  return json({ message, url, documentation_url: REDIRECT_DOCS }, status, { location: `${url}${req.url.search}` });
}

// Returns the response and the operation name for the call log, like
// "GET /repos/{owner}/{repo}". A call by a repo's ID answers as a call by
// its name.
export function handleRest(req: RestRequest, asked: string): { response: Response; operation: string } {
  let path = asked;
  const byId = BY_ID.exec(asked);
  if (byId) {
    const repo = findRepoById(req.ctx.state, Number(byId[1]));
    if (repo && canSee(repo, req.ctx.viewer, req.ctx.scopes)) path = `/repos/${fullName(repo)}${byId[2] ?? ''}`;
  }
  const redirect = movedAway(req, path);
  for (const route of routes) {
    const params = match(route, req.method, path);
    if (!params) continue;
    const operation = `${route.method} ${route.path.replace('+}', '}')}`;
    if (redirect) return { response: redirect, operation };
    if (route.auth && req.ctx.viewer === null) {
      return { response: errorResponse(401, 'Requires authentication', route.docs), operation };
    }
    try {
      return { response: route.handle(req, params), operation };
    } catch (error) {
      if (!(error instanceof FakeError)) throw error;
      return { response: errorResponse(STATUS[error.kind], error.message, route.docs, error.errors), operation };
    }
  }
  // GitHub answers an unknown path with a plain 404. The extra header says
  // the fake has no such route, in case a test needs one added.
  const response = errorResponse(404, 'Not Found', REST_DOCS);
  response.headers.set('x-github-fake', 'no such route');
  return { response, operation: `${req.method} ${path}` };
}
