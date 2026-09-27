// The parts of github.com the app uses: the OAuth web flow, avatars, and
// raw files. GitHub's authorize page asks the signed-in person to approve
// the app. The fake's page asks which sample person to sign in as instead,
// which is how local development signs in as anyone in the sample data. The
// app's dev sign-in posts that page's form itself, with `login` set.

import { base64ToBytes, bytesToBase64, lookupPath, readObject } from './git.ts';
import { json } from './http.ts';
import { findAccount, findRepo, type FakeState, type TokenRecord } from './state.ts';

export interface WebContext {
  state: FakeState;
  webUrl: string;
  now: Date;
  mintToken: (login: string, scopes: string[], clientId: string | null) => string;
}

const OAUTH_DOCS = 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps';
const TOKEN_ERRORS_DOCS =
  'https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors';
const AUTHORIZE_ERRORS_DOCS =
  'https://docs.github.com/apps/managing-oauth-apps/troubleshooting-authorization-request-errors';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// GitHub sends people back only to the app's callback URL or a path under
// it, on the same host and port. A loopback callback allows any port. GitHub
// documents that for 127.0.0.1, and the fake extends it to localhost.
function redirectAllowed(callback: string, redirect: string): boolean {
  let c: URL;
  let r: URL;
  try {
    c = new URL(callback);
    r = new URL(redirect);
  } catch {
    return false;
  }
  if (c.protocol !== r.protocol || c.hostname !== r.hostname) return false;
  if (!LOOPBACK.has(c.hostname) && c.port !== r.port) return false;
  const base = c.pathname.endsWith('/') ? c.pathname : `${c.pathname}/`;
  return r.pathname === c.pathname || r.pathname.startsWith(base);
}

function redirect(to: string, params: Record<string, string | null>): Response {
  const url = new URL(to);
  for (const [name, value] of Object.entries(params)) if (value !== null) url.searchParams.set(name, value);
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface AuthorizeParams {
  clientId: string;
  redirectUri: string | null;
  scope: string;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
}

function readAuthorizeParams(params: URLSearchParams): AuthorizeParams {
  return {
    clientId: params.get('client_id') ?? '',
    redirectUri: params.get('redirect_uri') || null,
    scope: params.get('scope') ?? '',
    state: params.get('state'),
    codeChallenge: params.get('code_challenge') || null,
    codeChallengeMethod: params.get('code_challenge_method') || null,
  };
}

function signInPage(ctx: WebContext, appName: string, params: AuthorizeParams): Response {
  const hidden = Object.entries({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
  })
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value ?? '')}">`)
    .join('\n      ');
  const people = Object.values(ctx.state.accounts)
    .filter((a) => a.type === 'User')
    .map(
      (a) =>
        `<li><button type="submit" name="login" value="${escapeHtml(a.login)}">@${escapeHtml(a.login)}</button> ${escapeHtml(a.name)}</li>`,
    )
    .join('\n        ');
  const scopes = params.scope.split(/[\s,]+/).filter(Boolean).join(', ') || 'public data only';
  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to the GitHub fake</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34em; margin: 48px auto; padding: 0 16px; color: #0e1116; }
  ul { list-style: none; padding: 0; }
  li { margin: 8px 0; }
  button { font: inherit; padding: 6px 14px; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>Sign in to the GitHub fake</h1>
  <p>This is the GitHub fake that local development and tests use. ${escapeHtml(appName)} asks for: ${escapeHtml(scopes)}.</p>
  <p>Pick a sample person. The app gets their token, the way it would from GitHub.</p>
  <form method="post" action="${ctx.webUrl}/login/oauth/authorize">
      ${hidden}
      <ul>
        ${people}
      </ul>
      <button type="submit" name="decision" value="deny">Cancel</button>
  </form>
</main>
</body>
</html>
`);
}

// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#1-request-a-users-github-identity
async function authorize(ctx: WebContext, request: Request, url: URL): Promise<Response> {
  const form = request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;
  const params = readAuthorizeParams(form);
  const app = ctx.state.oauthApps[params.clientId];
  if (!app) return html('<!doctype html><title>Not Found</title><h1>404</h1><p>No OAuth app has that client_id.</p>', 404);
  const back = params.redirectUri ?? app.callbackUrl;
  if (!redirectAllowed(app.callbackUrl, back)) {
    // https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-authorization-request-errors
    return redirect(app.callbackUrl, {
      error: 'redirect_uri_mismatch',
      error_description: 'The redirect_uri MUST match the registered callback URL for this application.',
      error_uri: `${AUTHORIZE_ERRORS_DOCS}#redirect-uri-mismatch`,
      state: params.state,
    });
  }
  if (params.codeChallenge !== null && params.codeChallengeMethod !== 'S256') {
    return redirect(back, {
      error: 'invalid_request',
      error_description: 'code_challenge_method must be S256.',
      error_uri: OAUTH_DOCS,
      state: params.state,
    });
  }
  if (request.method !== 'POST') return signInPage(ctx, app.name, params);
  if (form.get('decision') === 'deny') {
    return redirect(back, {
      error: 'access_denied',
      error_description: 'The user has denied your application access.',
      error_uri: `${AUTHORIZE_ERRORS_DOCS}#access-denied`,
      state: params.state,
    });
  }
  const person = findAccount(ctx.state, form.get('login') ?? '');
  if (person?.type !== 'User') return signInPage(ctx, app.name, params);
  // GitHub's codes are 20 hex characters and expire after 10 minutes.
  const code = randomHex(10);
  ctx.state.oauthCodes[code] = {
    clientId: app.clientId,
    login: person.login,
    redirectUri: params.redirectUri,
    scopes: params.scope.split(/[\s,]+/).filter(Boolean),
    codeChallenge: params.codeChallenge,
    expiresAt: new Date(ctx.now.getTime() + 10 * 60_000).toISOString(),
  };
  return redirect(back, { code, state: params.state });
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return bytesToBase64(new Uint8Array(digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Answers in JSON when asked, and form-encoded otherwise, as GitHub does.
// Errors come back with status 200.
function tokenReply(request: Request, body: Record<string, string>): Response {
  if ((request.headers.get('accept') ?? '').includes('application/json')) return json(body);
  return new Response(new URLSearchParams(body).toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  });
}

const TOKEN_ERRORS = {
  incorrect_client_credentials: 'The client_id and/or client_secret passed are incorrect.',
  redirect_uri_mismatch: 'The redirect_uri MUST match the registered callback URL for this application.',
  bad_verification_code: 'The code passed is incorrect or expired.',
};

// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github
async function accessToken(ctx: WebContext, request: Request, url: URL): Promise<Response> {
  const params = new URLSearchParams(url.searchParams);
  const text = await request.text();
  const type = request.headers.get('content-type') ?? '';
  let body: Record<string, unknown> = {};
  try {
    body = type.includes('application/json')
      ? (JSON.parse(text || '{}') as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(text));
  } catch {
    // Unreadable fields fail the checks below, as missing ones do.
  }
  for (const [name, value] of Object.entries(body)) if (typeof value === 'string') params.set(name, value);
  const error = (code: keyof typeof TOKEN_ERRORS) =>
    tokenReply(request, {
      error: code,
      error_description: TOKEN_ERRORS[code],
      error_uri: `${TOKEN_ERRORS_DOCS}#${code.replace(/_/g, '-')}`,
    });

  const app = ctx.state.oauthApps[params.get('client_id') ?? ''];
  if (!app || app.clientSecret !== params.get('client_secret')) return error('incorrect_client_credentials');
  const code = params.get('code') ?? '';
  const grant = ctx.state.oauthCodes[code];
  // A code works once.
  Reflect.deleteProperty(ctx.state.oauthCodes, code);
  if (!grant || grant.clientId !== app.clientId || Date.parse(grant.expiresAt) < ctx.now.getTime()) {
    return error('bad_verification_code');
  }
  const redirectUri = params.get('redirect_uri');
  if (grant.redirectUri !== null && redirectUri !== null && redirectUri !== grant.redirectUri) {
    return error('redirect_uri_mismatch');
  }
  if (grant.codeChallenge !== null && (await s256(params.get('code_verifier') ?? '')) !== grant.codeChallenge) {
    return error('bad_verification_code');
  }
  return tokenReply(request, {
    access_token: ctx.mintToken(grant.login, grant.scopes, app.clientId),
    scope: grant.scopes.join(','),
    token_type: 'bearer',
  });
}

// GitHub issues at most 10 tokens to one app for one person and one set of
// scopes. When it creates another, it revokes one of the existing ones: the
// oldest never used and created more than a minute ago, or else the least
// recently used, or else, when none was ever used, the oldest.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
export const TOKENS_PER_APP_AND_SCOPES = 10;

export function revokeOverTheCap(state: FakeState, issued: string, now: Date): void {
  const record = state.tokens[issued];
  if (!record) return;
  const scopes = (list: string[]) => [...list].sort().join(' ');
  const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);
  const others = Object.entries(state.tokens).filter(
    ([token, other]) =>
      token !== issued &&
      other.clientId === record.clientId &&
      other.login.toLowerCase() === record.login.toLowerCase() &&
      scopes(other.scopes) === scopes(record.scopes),
  );
  const byAge = (a: [string, TokenRecord], b: [string, TokenRecord]) => time(a[1].createdAt) - time(b[1].createdAt);
  while (others.length >= TOKENS_PER_APP_AND_SCOPES) {
    const unused = others.filter(([, other]) => !other.lastUsedAt).sort(byAge);
    const used = others
      .filter(([, other]) => other.lastUsedAt)
      .sort((a, b) => time(a[1].lastUsedAt) - time(b[1].lastUsedAt) || byAge(a, b));
    const stale = unused.find(([, other]) => now.getTime() - time(other.createdAt) > 60_000);
    const [token] = stale ?? used[0] ?? unused[0] ?? [];
    if (token === undefined) return;
    Reflect.deleteProperty(state.tokens, token);
    others.splice(
      others.findIndex(([other]) => other === token),
      1,
    );
  }
}

// Stands in for avatars.githubusercontent.com, so a page that shows avatars
// in local development makes no request off the machine.
function avatar(ctx: WebContext, id: string): Response {
  const account = Object.values(ctx.state.accounts).find((a) => String(a.id) === id);
  const letter = escapeHtml((account?.login ?? '?').charAt(0).toUpperCase());
  const hue = (Number(id) * 47) % 360;
  return new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${String(hue)} 60% 45%)"/><text x="32" y="42" font-family="sans-serif" font-size="28" text-anchor="middle" fill="#fff">${letter}</text></svg>`,
    { headers: { 'content-type': 'image/svg+xml' } },
  );
}

// Stands in for raw.githubusercontent.com, which download_url points at.
function raw(ctx: WebContext, owner: string, name: string, rest: string): Response {
  const repo = findRepo(ctx.state, owner, name);
  const notFound = new Response('404: Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
  // A raw file carries no token here, so a private repo's files are never served.
  if (!repo || repo.private === true) return notFound;
  // A branch name can hold slashes, so the longest branch that fits wins.
  const branch = Object.keys(repo.branches)
    .sort((a, b) => b.length - a.length)
    .find((b) => rest.startsWith(`${b}/`));
  const ref = branch ?? rest.split('/')[0] ?? '';
  const path = rest.slice(ref.length + 1);
  const sha = repo.branches[ref] ?? (ctx.state.objects[ref]?.type === 'commit' ? ref : undefined);
  if (sha === undefined) return notFound;
  const found = lookupPath(ctx.state.objects, readObject(ctx.state.objects, sha, 'commit').tree, path);
  if (found?.object.type !== 'blob') return notFound;
  return new Response(base64ToBytes(found.object.base64), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// Returns the response and the operation name for the call log.
export async function handleWeb(
  ctx: WebContext,
  request: Request,
  url: URL,
  path: string,
): Promise<{ response: Response; operation: string }> {
  if (path === '/login/oauth/authorize' && (request.method === 'GET' || request.method === 'POST')) {
    return { response: await authorize(ctx, request, url), operation: `${request.method} /login/oauth/authorize` };
  }
  if (path === '/login/oauth/access_token' && request.method === 'POST') {
    return { response: await accessToken(ctx, request, url), operation: 'POST /login/oauth/access_token' };
  }
  const avatarMatch = /^\/avatars\/u\/(\d+)$/.exec(path);
  if (avatarMatch && request.method === 'GET') {
    return { response: avatar(ctx, avatarMatch[1] ?? ''), operation: 'GET /avatars/u/{id}' };
  }
  const rawMatch = /^\/([^/]+)\/([^/]+)\/raw\/(.+)$/.exec(path);
  if (rawMatch && request.method === 'GET') {
    return {
      response: raw(ctx, rawMatch[1] ?? '', rawMatch[2] ?? '', decodeURIComponent(rawMatch[3] ?? '')),
      operation: 'GET /{owner}/{repo}/raw/{ref}/{path}',
    };
  }
  return {
    response: new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    operation: `${request.method} ${path}`,
  };
}
