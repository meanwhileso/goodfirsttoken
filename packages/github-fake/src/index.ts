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
import { handleRest } from './rest.ts';
import { sampleData as defaultSampleData, type SampleData } from './sample-data.ts';
import {
  addReview,
  closeIssue,
  findRepoByFullName,
  getAccount,
  getPull,
  mergePull,
  type FakeState,
  type RepoRecord,
  type ReviewInput,
} from './state.ts';
import { handleWeb } from './web.ts';

export type { FakeState, ReviewInput } from './state.ts';
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
}

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
  const calls: RecordedCall[] = [];

  const mintToken = (login: string, scopes: string[], clientId: string | null) => {
    const token = newToken();
    state.tokens[token] = { login: getAccount(state, login).login, scopes, clientId };
    return token;
  };

  async function answerApi(request: Request, url: URL, path: string) {
    const token = tokenFrom(request.headers.get('authorization'));
    const grant = token === null ? undefined : state.tokens[token];
    const login = grant?.login ?? null;
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
    const ctx = { state, apiUrl, webUrl, viewer: login };
    if (graphql) {
      const docs = 'https://docs.github.com/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql';
      if (request.method !== 'POST') return done(errorResponse(404, 'Not Found', REST_DOCS), operation);
      const name = typeof body.query === 'string' ? describeOperation(body.query, body.operationName as string) : operation;
      if (!grant) return done(errorResponse(401, 'This endpoint requires you to be authenticated.', docs), name);
      return done(json(await runGraphQL(ctx, body, now().toISOString())), name);
    }
    const app = appCredentialsFrom(request.headers.get('authorization'));
    const rest = handleRest({ ctx, method: request.method, url, body, app, now: now().toISOString() }, path);
    return done(rest.response, rest.operation);
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

  return {
    apiUrl,
    webUrl,
    get state() {
      return state;
    },
    calls,
    fetch,
    tokenFor: (login, scopes = ['public_repo']) => {
      if (getAccount(state, login).type !== 'User') throw new Error(`${login} is an organization. Tokens belong to people.`);
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
  };
}
