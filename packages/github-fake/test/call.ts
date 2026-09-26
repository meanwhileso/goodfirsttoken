import type { GitHubFake } from '../src/index.ts';

export interface Reply<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface GraphQLReply<T> {
  data?: T | null;
  errors?: { type?: string; message: string; path?: (string | number)[] }[];
}

// Calls the fake's REST API the way a client would.
export async function rest<T = unknown>(
  fake: GitHubFake,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply<T>> {
  const response = await fake.fetch(`${fake.apiUrl}${path}`, {
    method,
    headers: {
      'user-agent': 'github-fake-tests',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, headers: response.headers, body: (await response.json()) as T };
}

export async function graphql<T = unknown>(
  fake: GitHubFake,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Reply<GraphQLReply<T>>> {
  return rest<GraphQLReply<T>>(fake, 'POST', '/graphql', { token, body: { query, variables } });
}

export const toBase64 = (text: string) => Buffer.from(text).toString('base64');
export const fromBase64 = (text: string) => Buffer.from(text, 'base64').toString('utf8');
