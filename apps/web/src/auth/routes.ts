import { githubLogin } from '@goodfirsttoken/core';
import { symmetricDecrypt } from 'better-auth/crypto';
import { revokeGitHubToken } from '../github';
import { finishConnecting, MCP_CALLBACK_PATH } from '../mcp/authorize';
import { disconnect } from '../mcp/connections';
import { AUTH_BASE_PATH, failureReason, getAuth, type Auth } from './auth';
import { tooManySignIns, underSignInLimit } from './rate-limit';
import { gitHubAccount, readSignedIn } from './session';
import { SignInNotSetUp, isDevelopment, oauthApp, siteOrigin } from './settings';

// Every request under /auth comes here. Only the routes below answer, and
// every other path under /auth is a 404, so none of Better Auth's other
// endpoints, like email sign-up or account linking, can be reached.
//
//   POST /auth/sign-in              starts GitHub sign-in (a form on /sign-in)
//   GET  /auth/callback/github      where GitHub sends the person back
//   POST /auth/sign-out             signs out and revokes the GitHub token
//   POST /auth/dev/sign-in          development only: signs in as a sample person
//   GET  /auth/callback/mcp         where GitHub sends someone connecting an
//                                   agent back (src/mcp/authorize.ts)
//   POST /auth/agents/disconnect    disconnects one of the person's agents
//                                   (a form on /me)

const SIGN_IN_PAGE = '/sign-in';
const AFTER_SIGN_IN = '/me';
const AFTER_DISCONNECT = '/me';
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

const OTHER_SITE = () => text(403, 'Refused: this form was sent from another site.');

// Disconnects one of the signed-in person's agents, named by the form's
// `agent` field: the agent's next tool call gets a 401, and its GitHub token
// is revoked. An agent that isn't theirs, or is already gone, is left as it
// is, and they land on /me either way.
async function disconnectAgent(request: Request, origin: string): Promise<Response> {
  const { signedIn, setCookies } = await readSignedIn(request);
  if (!signedIn) return seeOther(SIGN_IN_PAGE, setCookies);
  const form = await request.formData().catch(() => null);
  const agent = form?.get('agent');
  if (typeof agent === 'string') await disconnect(origin, signedIn.githubId, agent);
  return seeOther(AFTER_DISCONNECT, setCookies);
}

// Starts sign-in the way Better Auth does: it keeps the state and the PKCE
// verifier in a row that lasts 10 minutes, sets a cookie that ties them to
// this browser and lasts 5, and returns GitHub's authorize URL. So a sign-in
// has 5 minutes to come back.
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
// it, and ends every session they had, since all of them used that token.
// The person is signed out even when GitHub can't revoke it. A sign-in in
// another browser while this runs stores a new token and a new session, and
// both stay, since this forgets only the token it revoked and ends only the
// sessions it found first.
async function signOut(auth: Auth, request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (session) {
    const context = await auth.$context;
    const sessions = await context.internalAdapter.listSessions(session.user.id);
    const account = await gitHubAccount(auth, session.user.id);
    const stored = account?.accessToken;
    if (account && stored) {
      try {
        await revokeGitHubToken(oauthApp(), await symmetricDecrypt({ key: context.secretConfig, data: stored }));
      } catch (error) {
        console.error(`GitHub didn't revoke a token at sign-out: ${failureReason(error)}`);
      }
      // Forgets the token only while it is still the one revoked. A sign-in
      // in another browser may have stored a new one meanwhile, and that one
      // stays.
      await context.adapter.update({
        model: 'account',
        where: [
          { field: 'id', value: account.id },
          { field: 'accessToken', value: stored },
        ],
        update: { accessToken: null },
      });
    }
    await context.internalAdapter.deleteSessions(sessions.map(({ token }) => token));
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

  // A form from another site is refused before it counts toward the limit,
  // so a page elsewhere can't use up someone's sign-ins.
  if (endpoint === `POST ${AUTH_BASE_PATH}/dev/sign-in`) {
    // Outside development this route doesn't exist.
    if (!isDevelopment()) return text(404, 'Not Found');
    if (!fromThisSite(request, origin)) return OTHER_SITE();
    if (!(await underSignInLimit(request))) return tooManySignIns();
    return devSignIn(getAuth(origin), request, origin);
  }
  if (endpoint === `POST ${AUTH_BASE_PATH}/sign-in`) {
    if (!fromThisSite(request, origin)) return OTHER_SITE();
    if (!(await underSignInLimit(request))) return tooManySignIns();
    const { url, setCookies } = await startSignIn(getAuth(origin), request);
    return seeOther(url, setCookies);
  }
  if (endpoint === `GET ${CALLBACK_PATH}`) {
    if (!(await underSignInLimit(request))) return tooManySignIns();
    const response = await getAuth(origin).handler(request);
    const answer = new Response(response.body, response);
    answer.headers.set('cache-control', 'no-store');
    return answer;
  }
  if (endpoint === `POST ${AUTH_BASE_PATH}/sign-out`) {
    if (!fromThisSite(request, origin)) return OTHER_SITE();
    return signOut(getAuth(origin), request);
  }
  if (endpoint === `GET ${MCP_CALLBACK_PATH}`) return finishConnecting(request);
  if (endpoint === `POST ${AUTH_BASE_PATH}/agents/disconnect`) {
    if (!fromThisSite(request, origin)) return OTHER_SITE();
    return disconnectAgent(request, origin);
  }
  return text(404, 'Not Found');
}
