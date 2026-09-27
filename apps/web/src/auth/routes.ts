import { githubLogin } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { GitHubError, revokeGitHubToken } from '../github';
import { AUTH_BASE_PATH, getAuth, type Auth } from './auth';
import { gitHubAccount } from './session';
import { SignInNotSetUp, isDevelopment, oauthApp, siteOrigin } from './settings';

// Every request under /auth comes here. Only the routes below answer, and
// every other path under /auth is a 404, so none of Better Auth's other
// endpoints, like email sign-up or account linking, can be reached.
//
//   POST /auth/sign-in           starts GitHub sign-in (a form on /sign-in)
//   GET  /auth/callback/github   where GitHub sends the person back
//   POST /auth/sign-out          signs out and revokes the GitHub token
//   POST /auth/dev/sign-in       development only: signs in as a sample person

const SIGN_IN_PAGE = '/sign-in';
const AFTER_SIGN_IN = '/me';
const AFTER_SIGN_OUT = '/';
const CALLBACK_PATH = `${AUTH_BASE_PATH}/callback/github`;

const NO_STORE = { 'cache-control': 'no-store' };

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE, ...headers },
  });
}

function seeOther(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location, ...NO_STORE });
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** True when the request is for a path under /auth. */
export function isAuthPath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`);
}

// Our forms post from our own pages, and browsers send Origin with every
// POST, so a form posted from another site, or with no Origin, is refused.
function fromThisSite(request: Request, origin: string): boolean {
  return request.headers.get('origin') === origin;
}

// Cloudflare's rate limiter, counted per client address. Cloudflare sets
// cf-connecting-ip on every request that reaches the Worker.
async function underLimit(request: Request): Promise<boolean> {
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.SIGN_IN_LIMITER.limit({ key });
  return success;
}

const TOO_MANY = () => text(429, 'Too many sign-ins from here. Try again in a minute.', { 'retry-after': '60' });
const OTHER_SITE = () => text(403, 'Refused: this form was sent from another site.');

// Starts sign-in the way Better Auth does: it keeps the state and the PKCE
// verifier for 10 minutes, sets a cookie that ties them to this browser, and
// returns GitHub's authorize URL.
async function startSignIn(auth: Auth, request: Request): Promise<{ url: string; setCookies: string[] }> {
  const { headers, response } = await auth.api.signInSocial({
    body: { provider: 'github', callbackURL: AFTER_SIGN_IN, errorCallbackURL: SIGN_IN_PAGE },
    headers: request.headers,
    returnHeaders: true,
  });
  if (!response.url) throw new Error('Better Auth returned no GitHub URL to sign in at.');
  return { url: response.url, setCookies: headers.getSetCookie() };
}

// Signing out revokes the GitHub token the site holds for the person, forgets
// it, and ends every session they have, since all of them use that token.
// The person is signed out even when GitHub can't revoke it.
async function signOut(auth: Auth, request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (session) {
    const context = await auth.$context;
    const account = await gitHubAccount(auth, session.user.id);
    if (account?.accessToken) {
      try {
        const { accessToken } = await auth.api.getAccessToken({
          body: { accountId: account.id, userId: session.user.id },
        });
        if (accessToken) await revokeGitHubToken(oauthApp(), accessToken);
      } catch (error) {
        // GitHub's status and message, or the kind of error. The token never
        // reaches a log.
        const reason =
          error instanceof GitHubError
            ? `${String(error.status)} ${error.message}`
            : error instanceof Error
              ? error.name
              : 'an unknown error';
        console.error(`GitHub didn't revoke a token at sign-out: ${reason}`);
      }
      await context.internalAdapter.updateAccount(account.id, { accessToken: null });
    }
    await context.internalAdapter.deleteUserSessions(session.user.id);
  }
  const { headers } = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
  return seeOther(AFTER_SIGN_OUT, headers.getSetCookie());
}

// Development only. Signs in as a sample person in one step by filling in
// the GitHub fake's sign-in page for them: it starts a normal sign-in, posts
// the person's login to the fake's authorize page, and sends the browser on
// to the callback with the code the fake gives. The session still comes from
// Better Auth's callback, with a token from the configured GitHub, so this
// can't sign anyone in on its own. Real GitHub has no such page.
async function devSignIn(auth: Auth, request: Request, origin: string): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const login = form?.get('login');
  if (typeof login !== 'string' || !githubLogin.safeParse(login).success) {
    return text(422, "Name a sample person's login, like login=priya.");
  }
  const started = await startSignIn(auth, request);
  const authorize = new URL(started.url);
  const fields = new URLSearchParams(authorize.searchParams);
  fields.set('login', login);
  const answer = await fetch(`${authorize.origin}${authorize.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields,
    redirect: 'manual',
  });
  const back = new URL(answer.headers.get('location') ?? '/', origin);
  if (answer.status !== 302 || `${back.origin}${back.pathname}` !== `${origin}${CALLBACK_PATH}` || !back.searchParams.get('code')) {
    return text(422, `The GitHub fake has no sample person @${login}.`);
  }
  return seeOther(back.toString(), started.setCookies);
}

/** Answers a request under /auth. */
export async function handleAuthRequest(request: Request): Promise<Response> {
  try {
    return await route(request);
  } catch (error) {
    if (!(error instanceof SignInNotSetUp)) throw error;
    console.error(`Sign-in is not set up: ${error.message}`);
    return text(503, "Sign-in isn't set up on this site yet.");
  }
}

async function route(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const origin = siteOrigin(request);
  const endpoint = `${request.method} ${pathname}`;

  if (endpoint === `POST ${AUTH_BASE_PATH}/dev/sign-in`) {
    // Outside development this route doesn't exist.
    if (!isDevelopment()) return text(404, 'Not Found');
    if (!(await underLimit(request))) return TOO_MANY();
    if (!fromThisSite(request, origin)) return OTHER_SITE();
    return devSignIn(getAuth(origin), request, origin);
  }
  if (endpoint === `POST ${AUTH_BASE_PATH}/sign-in`) {
    if (!(await underLimit(request))) return TOO_MANY();
    if (!fromThisSite(request, origin)) return OTHER_SITE();
    const { url, setCookies } = await startSignIn(getAuth(origin), request);
    return seeOther(url, setCookies);
  }
  if (endpoint === `GET ${CALLBACK_PATH}`) {
    if (!(await underLimit(request))) return TOO_MANY();
    const response = await getAuth(origin).handler(request);
    const answer = new Response(response.body, response);
    answer.headers.set('cache-control', 'no-store');
    return answer;
  }
  if (endpoint === `POST ${AUTH_BASE_PATH}/sign-out`) {
    if (!fromThisSite(request, origin)) return OTHER_SITE();
    return signOut(getAuth(origin), request);
  }
  return text(404, 'Not Found');
}
