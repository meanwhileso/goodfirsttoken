// The REST endpoints the app calls. Each route names its docs page, and
// errors send that page back as documentation_url, the way GitHub does.

import { lookupPath, readObject, type Oid } from './git.ts';
import { REST_DOCS, errorResponse, json, paginate } from './http.ts';
import { searchIssues, searchRepos } from './search.ts';
import {
  branchShape,
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
  forkRepo,
  getPull,
  key,
  newId,
  openPull,
  requirePush,
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

function resolveRef(repo: RepoRecord, ref: string | null, req: RestRequest): Oid {
  const name = ref ?? repo.defaultBranch;
  const sha = repo.branches[name.replace(/^refs\/heads\//, '')];
  if (sha !== undefined) return sha;
  if (req.ctx.state.objects[name]?.type === 'commit') return name;
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
      const app = req.ctx.state.oauthApps[params.client_id ?? ''];
      if (!app || req.app?.clientId !== app.clientId || req.app.clientSecret !== app.clientSecret) {
        throw new FakeError('not_found', 'Not Found');
      }
      const token = str(req.body.access_token);
      if (!token) {
        throw new FakeError('invalid', 'Validation Failed', [
          { resource: 'OauthAccess', code: 'missing_field', field: 'access_token' },
        ]);
      }
      if (req.ctx.state.tokens[token]?.clientId !== app.clientId) throw new FakeError('not_found', 'Not Found');
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
    // A person who already has a fork gets it back. Forking is instant here.
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
        { name: str(req.body.name), defaultBranchOnly: req.body.default_branch_only === true },
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
      const branch = params.branch ?? '';
      const sha = repo.branches[branch];
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
      const branch = /^heads\/(.+)$/.exec(params.ref ?? '')?.[1];
      const sha = branch === undefined ? undefined : repo.branches[branch];
      if (branch === undefined || sha === undefined) throw new FakeError('not_found', 'Not Found');
      return json(refShape(req.ctx, repo, branch, sha));
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
      const ref = str(req.body.ref) ?? '';
      const sha = str(req.body.sha) ?? '';
      const branch = /^refs\/heads\/(.+)$/.exec(ref)?.[1];
      if (branch === undefined) {
        throw new FakeError('invalid', "Reference name must start with 'refs/heads/' in the GitHub fake");
      }
      if (req.ctx.state.objects[sha]?.type !== 'commit') throw new FakeError('invalid', 'Object does not exist');
      if (repo.branches[branch] !== undefined) throw new FakeError('invalid', 'Reference already exists');
      repo.branches[branch] = sha;
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
      return list(req, getPull(repo, number).pull.reviews, (r) => reviewShape(req.ctx, repo, number, r));
    },
  },
  {
    method: 'GET',
    path: '/repos/{owner}/{repo}/pulls/{pull_number}/comments',
    docs: `${DOCS}/pulls/comments#list-review-comments-on-a-pull-request`,
    handle: (req, params) => {
      const repo = repoOf(req, params);
      const number = Number(params.pull_number);
      const comments = [...getPull(repo, number).pull.reviewComments];
      if (req.url.searchParams.get('direction') === 'desc') comments.reverse();
      return list(req, comments, (c) => reviewCommentShape(req.ctx, repo, number, c));
    },
  },
];

// A file is returned with its content. A folder is returned as a list of
// its entries.
function contents(req: RestRequest, params: Params): Response {
  const repo = repoOf(req, params);
  const ref = req.url.searchParams.get('ref');
  const sha = resolveRef(repo, ref, req);
  const refName = ref ?? repo.defaultBranch;
  const path = params.path ?? '';
  const store = req.ctx.state.objects;
  const found = lookupPath(store, readObject(store, sha, 'commit').tree, path);
  if (!found) throw new FakeError('not_found', 'Not Found');
  if (found.object.type === 'blob') return json(contentShape(req.ctx, repo, refName, path, found.oid, found.object, true));
  return json(
    found.object.entries.map((entry) => {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      return contentShape(req.ctx, repo, refName, entryPath, entry.oid, readObject(store, entry.oid, entry.type), false);
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

const STATUS = { not_found: 404, forbidden: 403, invalid: 422, stale: 409 };

// Returns the response and the operation name for the call log, like
// "GET /repos/{owner}/{repo}".
export function handleRest(req: RestRequest, path: string): { response: Response; operation: string } {
  for (const route of routes) {
    const params = match(route, req.method, path);
    if (!params) continue;
    const operation = `${route.method} ${route.path.replace('+}', '}')}`;
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
