import { env } from 'cloudflare:workers';

// Calls to GitHub. Every call names the token it runs with, and there is no
// default token. A call made for a person passes that person's own token.
// Reads that act for no one, like issue sync, will pass the read-only
// service token.
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
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
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
