// A fake GitHub for tests and local development. It answers the REST and
// GraphQL calls the app makes, and GitHub's OAuth web flow, from in-memory
// state built from the sample data. Every call records the token that made
// it and whose token that is, so a test can check that an action ran as the
// right person.
//
// In a test, hand `fake.fetch` to the code under test in place of the global
// fetch. It throws for any URL outside the fake's two base URLs, so nothing
// reaches the network. For `pnpm dev` and Playwright, server.ts serves the
// same fake over HTTP.

import { buildState } from './build.ts';
import { describeOperation, runGraphQL } from './graphql.ts';
import { REST_DOCS, errorResponse, json } from './http.ts';
import { rateHeaders, rateWindow, resourceOf, type RateResource } from './rate-limit.ts';
import { handleRest } from './rest.ts';
import { own, setOwn } from './own.ts';
import { sampleData as defaultSampleData, type SampleData } from './sample-data.ts';
import {
  addReview,
  assignIssue,
  canPush,
  closeIssue,
  commitOnBranch,
  findAccount,
  findIssue,
  findRepoByFullName,
  forkRepo,
  getAccount,
  getPull,
  labelIssue,
  mergePull,
  newId,
  openIssue,
  openPull,
  roleOf,
  unlabelIssue,
  updatePullBranch,
  type FakeState,
  type IssueRecord,
  type RepoRecord,
  type ReviewInput,
} from './state.ts';
import { handleWeb, revokeOverTheCap } from './web.ts';
import type { FileMode } from './git.ts';

export type { FakeState, ReviewInput } from './state.ts';
export type { FileMode } from './git.ts';
export type { RateResource } from './rate-limit.ts';
export type { SampleData } from './sample-data.ts';

// Hosts under the reserved .test domain, which never resolves.
export const DEFAULT_API_URL = 'https://api.github.test';
export const DEFAULT_WEB_URL = 'https://github.test';

export interface GitHubFakeOptions {
  // Where the fake answers GitHub's REST and GraphQL API (api.github.com).
  apiUrl?: string;
  // Where the fake answers github.com itself: OAuth, avatars, raw files.
  webUrl?: string;
  sampleData?: SampleData;
  now?: () => Date;
  // Start from saved state in place of the sample data.
  state?: FakeState;
  // How long GitHub takes to make a fork's git data, which it does in the
  // background. DEFAULT_FORK_DELAY_MS unless given.
  forkDelayMs?: number;
}

// GitHub makes a fork in the background, so a new fork's git data isn't
// there for a moment. The fake takes this long.
export const DEFAULT_FORK_DELAY_MS = 1000;

export interface RecordedCall {
  method: string;
  url: string;
  // The endpoint, like "GET /repos/{owner}/{repo}", or for GraphQL the
  // operation and its top-level fields, like "mutation createCommitOnBranch".
  operation: string;
  // The token the call carried, and whose it is. Both are null for a call
  // with no token. A token the fake never issued has a null login.
  token: string | null;
  login: string | null;
  status: number;
}

export interface GitHubFake {
  readonly apiUrl: string;
  readonly webUrl: string;
  // The fake's data. Tests may read or change it to set up a case.
  readonly state: FakeState;
  // Every call so far, oldest first.
  readonly calls: RecordedCall[];
  // How long a new fork's git data takes. A test can change it.
  forkDelayMs: number;
  // Answers a request the way GitHub would. It has fetch's signature.
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  // A new OAuth token for a sample person, like one from the token endpoint.
  tokenFor: (login: string, scopes?: string[]) => string;
  // Back to the sample data, with no calls recorded and no tokens issued.
  reset: () => void;
  // Things maintainers do on GitHub, for tests to set up what the app sees.
  mergePullRequest: (repo: string, number: number, by: string) => void;
  closePullRequest: (repo: string, number: number, by: string) => void;
  reviewPullRequest: (repo: string, number: number, review: ReviewInput) => void;
  // Commits these files, path to text, to the repo's default branch as
  // `by`, or to `branch`, and returns the commit's ID. A file given null is
  // deleted. A file is 100644 unless `modes` gives it another mode. For a
  // submodule, 160000, its text is the ID of the commit it names.
  commitFiles: (
    repo: string,
    files: Record<string, string | null>,
    by: string,
    options?: { branch?: string; modes?: Record<string, FileMode> },
  ) => string;
  // Clicks Update branch on a PR as `by`: the base branch merges into the
  // PR's branch. Returns the merge commit's ID.
  updatePullRequestBranch: (repo: string, number: number, by: string) => string;
  // Opens an issue as `by`, with the labels given, and returns its number.
  openIssue: (repo: string, issue: { title: string; body?: string; labels?: string[]; by: string }) => number;
  labelIssue: (repo: string, number: number, label: string, by: string) => void;
  unlabelIssue: (repo: string, number: number, label: string, by: string) => void;
  assignIssue: (repo: string, number: number, assignee: string, by: string) => void;
  closeIssue: (repo: string, number: number, by: string) => void;
  // Opens a PR as `by`, from a branch in the repo when they can push there
  // and from their fork when they can't, and returns its number. `base` is
  // the repo's default branch unless given, and is made from it when the
  // repo lacks it.
  openPullRequest: (repo: string, pull: { title: string; body: string; by: string; base?: string }) => number;
  // Counts `requests` more calls against the person's budget for the
  // resource, as other clients of theirs would.
  spendRateLimit: (login: string, resource: RateResource, requests: number) => void;
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// GitHub's OAuth tokens are gho_ and 36 letters and digits. Each random byte
// keeps its low 6 bits, 0 to 63, and 62 and 63 are skipped, so every letter
// and digit is equally likely.
function newToken(): string {
  let token = '';
  while (token.length < 36) {
    for (const byte of crypto.getRandomValues(new Uint8Array(36))) {
      const char = ALPHANUMERIC[byte & 63];
      if (char !== undefined && token.length < 36) token += char;
    }
  }
  return `gho_${token}`;
}

function relativePath(url: URL, base: URL): string | null {
  if (url.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null;
  return url.pathname.slice(basePath.length) || '/';
}

function tokenFrom(header: string | null): string | null {
  const match = /^(?:bearer|token)\s+(\S+)$/i.exec(header?.trim() ?? '');
  return match?.[1] ?? null;
}

// An OAuth app's client ID and secret, sent with Basic authentication, as
// GitHub's endpoints for an app's own tokens take them.
function appCredentialsFrom(header: string | null): { clientId: string; clientSecret: string } | null {
  const match = /^basic\s+(\S+)$/i.exec(header?.trim() ?? '');
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { clientId: decoded.slice(0, colon), clientSecret: decoded.slice(colon + 1) };
}

const RATE_LIMIT_DOCS = 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api';

const USER_AGENT_REQUIRED =
  'Request forbidden by administrative rules. Please make sure your request has a User-Agent header (https://docs.github.com/en/rest/overview/resources-in-the-rest-api#user-agent-required). Check https://developer.github.com for other possible causes.';

export function createGitHubFake(options: GitHubFakeOptions = {}): GitHubFake {
  const api = new URL(options.apiUrl ?? DEFAULT_API_URL);
  const web = new URL(options.webUrl ?? DEFAULT_WEB_URL);
  const apiUrl = api.toString().replace(/\/+$/, '');
  const webUrl = web.toString().replace(/\/+$/, '');
  const now = options.now ?? (() => new Date());
  const sample = options.sampleData ?? defaultSampleData;
  let state = options.state ?? buildState(sample, now());
  let forkDelayMs = options.forkDelayMs ?? DEFAULT_FORK_DELAY_MS;
  const calls: RecordedCall[] = [];

  const mintToken = (login: string, scopes: string[], clientId: string | null) => {
    const token = newToken();
    const issued = now();
    state.tokens[token] = { login: getAccount(state, login).login, scopes, clientId, createdAt: issued.toISOString(), lastUsedAt: null };
    if (clientId !== null) revokeOverTheCap(state, token, issued);
    return token;
  };

  async function answerApi(request: Request, url: URL, path: string) {
    const token = tokenFrom(request.headers.get('authorization'));
    const grant = token === null ? undefined : own(state.tokens, token);
    const login = grant?.login ?? null;
    // GitHub keeps when each token was last used, which decides the one it
    // revokes past the cap (web.ts).
    if (grant) grant.lastUsedAt = now().toISOString();
    const done = (response: Response, operation: string) => {
      response.headers.set('x-github-api-version-selected', '2022-11-28');
      if (grant) response.headers.set('x-oauth-scopes', grant.scopes.join(', '));
      return { response, operation, token, login };
    };
    const graphql = path === '/graphql';
    const operation = graphql ? 'graphql' : `${request.method} ${path}`;
    if (!request.headers.get('user-agent')) {
      return done(new Response(USER_AGENT_REQUIRED, { status: 403, headers: { 'content-type': 'text/plain' } }), operation);
    }
    if (token !== null && !grant) return done(errorResponse(401, 'Bad credentials', REST_DOCS), operation);
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    let body: Record<string, unknown>;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return done(errorResponse(400, 'Problems parsing JSON', REST_DOCS), operation);
    }
    const at = now();
    const ctx = { state, apiUrl, webUrl, viewer: login, scopes: grant?.scopes ?? [], now: at.toISOString() };
    const app = appCredentialsFrom(request.headers.get('authorization'));
    let name = operation;
    if (graphql) {
      const docs = 'https://docs.github.com/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql';
      if (request.method !== 'POST') return done(errorResponse(404, 'Not Found', REST_DOCS), operation);
      name = typeof body.query === 'string' ? describeOperation(body.query, body.operationName as string) : operation;
      if (!grant) return done(errorResponse(401, 'This endpoint requires you to be authenticated.', docs), name);
    }
    // Each call counts against its caller's budget, and every answer says
    // what is left of it. The fake charges a GraphQL query one point,
    // whatever it asks for.
    const resource = resourceOf(path);
    const caller = login ?? (app ? `app:${app.clientId}` : null);
    // Asking what is left costs nothing.
    // https://docs.github.com/en/rest/rate-limit/rate-limit#get-rate-limit-status-for-the-authenticated-user
    if (path === '/rate_limit' && request.method === 'GET') {
      const status = (name: RateResource) => {
        const window = rateWindow(state, caller, name, now());
        return {
          limit: window.limit,
          used: window.used,
          remaining: Math.max(0, window.limit - window.used),
          reset: Math.floor(Date.parse(window.resetAt) / 1000),
        };
      };
      const resources = { core: status('core'), graphql: status('graphql'), search: status('search') };
      const response = json({ resources, rate: resources.core });
      for (const [header, value] of Object.entries(rateHeaders(rateWindow(state, caller, 'core', now()), 'core'))) {
        response.headers.set(header, value);
      }
      return done(response, 'GET /rate_limit');
    }
    const budget = rateWindow(state, caller, resource, now());
    const spent = budget.used >= budget.limit;
    if (!spent) budget.used += 1;
    const answer = (response: Response, operationName: string) => {
      for (const [header, value] of Object.entries(rateHeaders(budget, resource))) response.headers.set(header, value);
      return done(response, operationName);
    };
    if (spent) {
      const who = caller === null ? 'this address' : `user ID ${String(findAccount(state, caller)?.id ?? caller)}`;
      const message = `API rate limit exceeded for ${who}.`;
      // GraphQL answers a spent budget with 200 and an error, REST with 403.
      if (graphql) return answer(json({ errors: [{ type: 'RATE_LIMITED', message }] }), name);
      return answer(errorResponse(403, message, RATE_LIMIT_DOCS), name);
    }
    if (graphql) return answer(json(await runGraphQL(ctx, body, ctx.now)), name);
    const forkReadyAt = new Date(at.getTime() + forkDelayMs).toISOString();
    const rest = handleRest({ ctx, method: request.method, url, body, app, now: ctx.now, forkReadyAt }, path);
    return answer(rest.response, rest.operation);
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const apiPath = relativePath(url, api);
    const webPath = apiPath === null ? relativePath(url, web) : null;
    if (apiPath === null && webPath === null) {
      throw new TypeError(
        `The GitHub fake answers only ${apiUrl} and ${webUrl}, and refused ${url.toString()}. Nothing in a test reaches the network.`,
      );
    }
    const result =
      apiPath !== null
        ? await answerApi(request, url, apiPath)
        : {
            ...(await handleWeb({ state, webUrl, now: now(), mintToken }, request, url, webPath ?? '/')),
            token: null,
            login: null,
          };
    calls.push({
      method: request.method,
      url: url.toString(),
      operation: result.operation,
      token: result.token,
      login: result.login,
      status: result.response.status,
    });
    return result.response;
  };

  const repoNamed = (name: string): RepoRecord => {
    const repo = findRepoByFullName(state, name);
    if (!repo) throw new Error(`the fake has no repo ${name}`);
    return repo;
  };

  const issueNamed = (repo: string, number: number): IssueRecord => {
    const issue = findIssue(repoNamed(repo), number);
    if (!issue) throw new Error(`the fake has no issue ${repo}#${String(number)}`);
    return issue;
  };

  return {
    apiUrl,
    webUrl,
    get state() {
      return state;
    },
    calls,
    get forkDelayMs() {
      return forkDelayMs;
    },
    set forkDelayMs(ms: number) {
      forkDelayMs = ms;
    },
    fetch,
    tokenFor: (login, scopes = ['public_repo']) => {
      if (getAccount(state, login).type !== 'User') throw new Error(`${login} is an organization or a bot. Tokens belong to people.`);
      return mintToken(login, scopes, null);
    },
    reset: () => {
      state = buildState(sample, now());
      calls.length = 0;
    },
    mergePullRequest: (repo, number, by) => {
      mergePull(state, repoNamed(repo), number, by, now().toISOString());
    },
    closePullRequest: (repo, number, by) => {
      closeIssue(state, getPull(repoNamed(repo), number), by, null, now().toISOString());
    },
    reviewPullRequest: (repo, number, review) => {
      addReview(state, repoNamed(repo), number, review, now().toISOString());
    },
    commitFiles: (repo, files, by, options = {}) => {
      const record = repoNamed(repo);
      const additions = Object.entries(files).flatMap(([path, contents]) =>
        contents === null ? [] : [{ path, contents, mode: own(options.modes ?? {}, path) }],
      );
      const deletions = Object.entries(files).flatMap(([path, contents]) => (contents === null ? [path] : []));
      return commitOnBranch(
        state,
        record,
        options.branch ?? record.defaultBranch,
        { additions, deletions, headline: 'Update files', login: by },
        now().toISOString(),
      );
    },
    updatePullRequestBranch: (repo, number, by) => updatePullBranch(state, repoNamed(repo), number, by, now().toISOString()),
    openIssue: (repo, issue) =>
      openIssue(
        state,
        repoNamed(repo),
        { title: issue.title, body: issue.body ?? null, labels: issue.labels, login: issue.by },
        now().toISOString(),
      ).number,
    labelIssue: (repo, number, label, by) => {
      labelIssue(state, repoNamed(repo), issueNamed(repo, number), label, by, now().toISOString());
    },
    unlabelIssue: (repo, number, label, by) => {
      unlabelIssue(state, repoNamed(repo), issueNamed(repo, number), label, by, now().toISOString());
    },
    assignIssue: (repo, number, assignee, by) => {
      assignIssue(state, issueNamed(repo, number), assignee, by, now().toISOString());
    },
    closeIssue: (repo, number, by) => {
      closeIssue(state, issueNamed(repo, number), by, 'completed', now().toISOString());
    },
    openPullRequest: (repo, pull) => {
      const at = now().toISOString();
      const base = repoNamed(repo);
      const author = getAccount(state, pull.by).login;
      const baseRef = pull.base ?? base.defaultBranch;
      if (own(base.branches, baseRef) === undefined) setOwn(base.branches, baseRef, own(base.branches, base.defaultBranch) ?? '');
      const target = canPush(roleOf(base, author)) ? base : forkRepo(state, base, author, {}, at);
      const branch = `patch-${String(newId(state))}`;
      setOwn(target.branches, branch, own(base.branches, baseRef) ?? '');
      commitOnBranch(
        state,
        target,
        branch,
        { additions: [{ path: `changes/${branch}.md`, contents: `${pull.title}\n` }], deletions: [], headline: pull.title, login: author },
        at,
      );
      const head = target === base ? branch : `${author}:${branch}`;
      return openPull(state, base, { title: pull.title, body: pull.body, head, base: baseRef, login: author }, at).number;
    },
    spendRateLimit: (login, resource, requests) => {
      rateWindow(state, login, resource, now()).used += requests;
    },
  };
}
