import { env } from 'cloudflare:workers';

// Calls to GitHub's API. Every call names the token it runs with, and there
// is no default token. A call made for a person passes that person's own
// token. Reads that act for no one, like issue sync, will pass the read-only
// service token. Revoking a token runs as the OAuth app, with its client ID
// and secret.
//
// GitHub's base URLs come from GH_API_URL and GH_WEB_URL. Local development
// and tests point them at the fake in packages/github-fake. A deploy that
// leaves them unset gets empty values, and then calls go to GitHub itself.

// https://docs.github.com/en/rest/about-the-rest-api/api-versions
const API_VERSION = '2022-11-28';

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function gitHubUrls() {
  const vars: Partial<Pick<Env, 'GH_API_URL' | 'GH_WEB_URL'>> = env;
  return {
    api: vars.GH_API_URL || 'https://api.github.com',
    web: vars.GH_WEB_URL || 'https://github.com',
  };
}

// GitHub refuses API calls that carry no User-Agent.
function headers(token: string, json: boolean): Record<string, string> {
  return apiHeaders(`Bearer ${token}`, json);
}

function apiHeaders(authorization: string, json: boolean): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization,
    'user-agent': 'goodfirsttoken',
    'x-github-api-version': API_VERSION,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

async function refusal(response: Response): Promise<GitHubError> {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return new GitHubError(response.status, body?.message ?? response.statusText);
}

// Calls the REST API as the person whose token is given. Throws a
// GitHubError with GitHub's status and message when GitHub refuses.
export async function gitHubRest<T>(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${gitHubUrls().api}${path}`, {
    method,
    headers: headers(token, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await refusal(response);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

// Revokes one token the OAuth app issued, so it stops working at once. This
// call runs as the app, with its client ID and secret, and names the token to
// revoke in the body. It acts on that token only, so a person's other tokens
// from the same app, like their agents', keep working. Throws a GitHubError
// when GitHub refuses.
// https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token
export async function revokeGitHubToken(app: OAuthApp, token: string): Promise<void> {
  const response = await fetch(`${gitHubUrls().api}/applications/${encodeURIComponent(app.clientId)}/token`, {
    method: 'DELETE',
    headers: apiHeaders(`Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`, true),
    body: JSON.stringify({ access_token: token }),
  });
  if (!response.ok) throw await refusal(response);
}

// Trades the code GitHub sent back to an OAuth sign-in for the person's
// token, at github.com itself, with the PKCE verifier the sign-in started
// with. GitHub answers a refused code with 200 and an `error` field, which
// comes back as a GitHubError with GitHub's description. Nothing here puts
// GitHub's answer in an error, since a good one holds the token. The site's
// own sign-in trades codes through Better Auth, in src/auth/auth.ts.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github
export async function exchangeGitHubCode(
  app: OAuthApp,
  input: { code: string; redirectUri: string; codeVerifier: string },
): Promise<string> {
  const response = await fetch(`${gitHubUrls().web}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'goodfirsttoken',
    },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
    redirect: 'manual',
  });
  if (!response.ok) throw new GitHubError(response.status, response.statusText);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof data?.access_token === 'string' && data.error === undefined) return data.access_token;
  const reason = typeof data?.error === 'string' ? data.error : 'no token';
  throw new GitHubError(response.status, `GitHub gave no token: ${reason}`);
}

export interface GraphQLError {
  type?: string;
  message: string;
  path?: (string | number)[];
}

export interface GraphQLResult<T> {
  data: T | null;
  errors: GraphQLError[];
}

// Calls the GraphQL API as the person whose token is given. GitHub answers a
// query with whatever data it could get and an error for each part it
// couldn't, like a repo that doesn't exist, so both come back.
export async function gitHubGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLResult<T>> {
  const response = await fetch(`${gitHubUrls().api}/graphql`, {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw await refusal(response);
  const result: { data?: T | null; errors?: GraphQLError[] } = await response.json();
  return { data: result.data ?? null, errors: result.errors ?? [] };
}
