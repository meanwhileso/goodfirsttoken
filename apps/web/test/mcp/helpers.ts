import type { GitHubFake } from '@goodfirsttoken/github-fake';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { limiterKey } from '../../src/auth/rate-limit';
import { APP, Browser, ORIGIN, location, pickOnGitHub, randomAddress } from '../auth/helpers';

// An agent that connects to the MCP server with the official MCP client SDK:
// it finds the server's OAuth metadata, registers itself, and signs in with
// PKCE. The person's side of the sign-in runs in a Browser from the sign-in
// tests, which approves the agent on the site and picks a sample person on
// the GitHub fake.

export const MCP_URL = `${ORIGIN}/mcp`;

/** Where each test agent says it listens for its code. Nothing listens, since the test reads the redirect. */
export const REDIRECT_URI = 'http://127.0.0.1:33418/callback';

/** An OAuth client that keeps its registration, tokens, and PKCE verifier in memory, as a harness would. */
export class MemoryOAuthClient implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  /** The URL the SDK sent the person to, to approve the agent. */
  authorizationUrl: URL | undefined;
  readonly name: string;

  constructor(name = 'Claude Code (test)') {
    this.name = name;
  }

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.client = client;
  }

  tokens() {
    return this.saved;
  }

  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    return this.verifier;
  }
}

/** Calls the whole Worker, the way an agent on the internet reaches it, from its own address. */
export function agentFetch(address = randomAddress()) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    request.headers.set('cf-connecting-ip', address);
    return exports.default.fetch(request);
  };
}

/** An MCP client for `oauth`, ready to connect. */
export function mcpClient(oauth: MemoryOAuthClient, fetch = agentFetch()) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: oauth, fetch });
  const client = new Client({ name: 'goodfirsttoken-tests', version: '0.0.0' });
  return { client, transport };
}

/** The consent page's form handle, from its HTML. */
export function consentHandle(html: string): string | null {
  return /<input type="hidden" name="handle" value="([^"]+)"/.exec(html)?.[1] ?? null;
}

/**
 * The person's side of an agent's sign-in: opens the page the agent sent
 * them to, approves the agent, picks `login` on the GitHub fake, and comes
 * back to the site, which sends them on to the agent. Returns where the site
 * sent them.
 */
export async function approveInBrowser(
  browser: Browser,
  github: GitHubFake,
  authorizationUrl: URL,
  login: string,
): Promise<URL> {
  const page = await browser.fetch(authorizationUrl.toString());
  expect(page.status).toBe(200);
  const handle = consentHandle(await page.text());
  if (!handle) throw new Error('The consent page has no form handle.');
  const approved = await browser.post('/oauth/authorize', { handle, decision: 'approve' });
  expect(approved.status).toBe(303);
  const back = await pickOnGitHub(github, location(approved), login);
  return location(await browser.fetch(back.toString()));
}

export interface ConnectedAgent {
  client: Client;
  transport: StreamableHTTPClientTransport;
  oauth: MemoryOAuthClient;
}

/**
 * Connects a new agent for `login`, the whole way: the SDK meets the 401,
 * finds the metadata, registers, and sends the person to approve it. The
 * person approves it and signs in with GitHub. The SDK trades the code for
 * tokens with its PKCE verifier and connects.
 */
export async function connectAgent(
  github: GitHubFake,
  login: string,
  { browser = new Browser(), oauth = new MemoryOAuthClient() }: { browser?: Browser; oauth?: MemoryOAuthClient } = {},
): Promise<ConnectedAgent> {
  const first = mcpClient(oauth);
  await expect(first.client.connect(first.transport)).rejects.toThrow(UnauthorizedError);
  if (!oauth.authorizationUrl) throw new Error('The SDK never asked the person to approve the agent.');
  const back = await approveInBrowser(browser, github, oauth.authorizationUrl, login);
  const code = back.searchParams.get('code');
  if (!code) throw new Error(`The site sent the person back without a code: ${back.toString()}`);
  await first.transport.finishAuth(back.searchParams);
  const connected = mcpClient(oauth);
  await connected.client.connect(connected.transport);
  return { ...connected, oauth };
}

/** Calls start_session as the agent. */
export function startSession(agent: { client: Client }) {
  return agent.client.callTool({
    name: 'start_session',
    arguments: { agent: 'claude-code', budget: { kind: 'issues', count: 2 } },
  });
}

/** A PKCE verifier and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: encode(new Uint8Array(digest)) };
}

/** Registers an agent with the server's dynamic client registration, the way the SDK does. Returns its client ID. */
export async function registerClient(
  name = 'Hand-made agent',
  redirectUri = REDIRECT_URI,
  fetch = agentFetch(),
): Promise<string> {
  const response = await fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ client_id: string }>()).client_id;
}

/** The page an agent sends the person to, to approve it. */
export function authorizeUrl(
  clientId: string,
  { challenge, redirectUri = REDIRECT_URI, state = 'agent-state' }: { challenge?: string; redirectUri?: string; state?: string },
): URL {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    resource: MCP_URL,
    ...(challenge === undefined ? {} : { code_challenge: challenge, code_challenge_method: 'S256' }),
  }).toString();
  return url;
}

/** Trades a code at the token endpoint, as an agent does. */
export async function tradeCode(clientId: string, code: string, verifier: string | undefined, fetch = agentFetch()) {
  const response = await fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      ...(verifier === undefined ? {} : { code_verifier: verifier }),
    }),
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/**
 * Connects an agent by hand, without the SDK: registers it, has the person
 * approve it and sign in as `login`, and trades the code with its PKCE
 * verifier. Returns its access and refresh tokens. It never calls /mcp.
 */
export async function tokensFor(github: GitHubFake, login: string, browser = new Browser()) {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const back = await approveInBrowser(browser, github, authorizeUrl(clientId, { challenge }), login);
  const traded = await tradeCode(clientId, back.searchParams.get('code') ?? '', verifier);
  expect(traded.status).toBe(200);
  return { clientId, accessToken: String(traded.body.access_token), refreshToken: String(traded.body.refresh_token) };
}

/** How many requests to /oauth/token each address gets a minute. */
export const TOKEN_LIMIT = 600;

/** A refresh at /oauth/token with a token and client that don't exist, which the library refuses. */
export function refreshNothing(fetch = agentFetch()): Promise<Response> {
  return fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'a:b:c', client_id: 'nobody' }),
  });
}

/**
 * Counts `count` requests to /oauth/token from `address` against its limit,
 * straight on TOKEN_LIMITER, as if the address had sent them. Hundreds of
 * requests through the Worker would slow every later test in the file.
 */
export async function useUpTokenRequests(address: string, count = TOKEN_LIMIT): Promise<void> {
  const key = limiterKey(address);
  for (let i = 0; i < count; i++) await env.TOKEN_LIMITER.limit({ key });
}

/** Sends one MCP request to /mcp with `accessToken`, as an agent on the 2025 protocol does: a tools/list. */
export function callMcp(accessToken: string, fetch = agentFetch()): Promise<Response> {
  return fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

/** The JSON-RPC message an MCP answer carries, sent as JSON or as one server-sent event. */
export async function mcpMessage<T>(response: Response): Promise<T> {
  const body = await response.text();
  const data = /^data: (.*)$/m.exec(body)?.[1];
  return JSON.parse(data ?? body) as T;
}

/** The GitHub tokens the fake gave the site's OAuth app, which it still honors. */
export function appTokens(github: GitHubFake): string[] {
  return Object.entries(github.state.tokens)
    .filter(([, grant]) => grant.clientId === APP.clientId)
    .map(([token]) => token);
}

/** Every key and value in the OAUTH_KV namespace, with each key's metadata, as one string. */
export async function wholeKv(): Promise<string> {
  const entries: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list(cursor === undefined ? {} : { cursor });
    for (const key of page.keys) entries.push([key.name, key.metadata, await env.OAUTH_KV.get(key.name)]);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return JSON.stringify(entries);
}

// Each run of base64 or base64url characters in `text`, decoded, as bytes
// read one to a character and as UTF-8.
function decodings(text: string): string[] {
  const decoded: string[] = [];
  for (const run of text.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? []) {
    const base64 = run.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
    if (base64.length % 4 === 1) continue;
    const bytes = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    decoded.push(bytes, new TextDecoder().decode(Uint8Array.from(bytes, (byte) => byte.charCodeAt(0))));
  }
  return decoded;
}

/**
 * Every string in the OAUTH_KV namespace, keys, values, and metadata, with
 * each JSON value read into its strings, and each string also decoded from
 * base64 or base64url wherever part of it reads as either, twice over. So a
 * value stored only encoded, even inside JSON inside base64, is here as text.
 */
export async function readableKv(): Promise<string> {
  const found: string[] = [];
  const read = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      found.push(value);
      if (depth >= 3) return;
      for (const text of [value, ...decodings(value)]) {
        if (text !== value) found.push(text);
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === 'object' && parsed !== null) read(parsed, depth + 1);
        } catch {
          // Not JSON.
        }
        if (text !== value) read(text, depth + 1);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) read(item, depth);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        read(key, depth);
        read(item, depth);
      }
    }
  };
  read(JSON.parse(await wholeKv()), 0);
  return found.join('\n');
}

/** A secret as it reads in base64 and base64url, besides itself. */
export function encodings(secret: string): string[] {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(secret)));
  return [secret, base64, base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')];
}

/** Empties the OAUTH_KV namespace, so each test starts with no grants or clients. */
export async function emptyKv(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list(cursor === undefined ? {} : { cursor });
    await Promise.all(page.keys.map((key) => env.OAUTH_KV.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
}
