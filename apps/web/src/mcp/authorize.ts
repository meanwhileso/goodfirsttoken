import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { env } from 'cloudflare:workers';
import { AUTH_BASE_PATH, failureReason, GITHUB_SCOPE } from '../auth/auth';
import { tooManySignIns, underSignInLimit } from '../auth/rate-limit';
import { oauthApp, SignInNotSetUp, siteOrigin } from '../auth/settings';
import { savePerson } from '../db';
import { exchangeGitHubCode, GitHubError, gitHubRest, gitHubUrls, revokeGitHubToken } from '../github';
import { addConnection, clientNameOf, disconnect, endReplacedConnections, revokeUnlessHeld } from './connections';
import { AUTHORIZE_PATH, REGISTER_PATH } from './paths';
import { oauthApi, type AgentProps } from './provider';

// An agent's sign-in to the MCP server, in three steps.
//
//   GET  /oauth/authorize      the page where the person approves the agent
//                              (src/routes/oauth/authorize.tsx, with
//                              openConsent below)
//   POST /oauth/authorize      their answer. Approving sends them to GitHub.
//   GET  /auth/callback/mcp    where GitHub sends them back. The agent gets
//                              its grant, holding their GitHub token.
//
// Any MCP client can register itself and name any redirect URI, and GitHub
// skips its own page for someone who already approved the app. So the page
// comes first, before GitHub, and shows where the access will go. The
// library's helpers bind each step to the browser that started it with a
// short-lived cookie, and keep the request itself in OAUTH_KV, so nothing a
// form sends can change the client or where its code goes.

/** Where GitHub sends the person back, under the OAuth app's callback URL. */
export const MCP_CALLBACK_PATH = `${AUTH_BASE_PATH}/callback/mcp`;

const NO_STORE = { 'cache-control': 'no-store' };

function text(status: number, body: string, headers: HeadersInit = {}): Response {
  const answer = new Headers(headers);
  answer.set('content-type', 'text/plain; charset=utf-8');
  answer.set('cache-control', 'no-store');
  return new Response(`${body}\n`, { status, headers: answer });
}

/**
 * Counts two steps of an agent's sign-in toward the sign-in limit, since each
 * stores something in OAUTH_KV for anyone who asks: registering a client, and
 * opening the page to approve one. The approval and GitHub's return count
 * where they are answered. Returns the 429 for an address over the limit, or
 * null.
 */
export async function limitAgentSignIn(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const counted =
    (pathname === REGISTER_PATH && request.method === 'POST') || (pathname === AUTHORIZE_PATH && request.method !== 'POST');
  if (!counted || (await underSignInLimit(request))) return null;
  return tooManySignIns();
}

const START_AGAIN =
  "This sign-in expired, was already used, or was started in another browser. Connect again from your agent.";

const BAD_LINK = "This link to connect an agent isn't right. Connect again from your agent.";

/** The consent page, or why there is none. */
export type Consent =
  | {
      kind: 'consent';
      /** Ties the form to this browser. It works once, for 10 minutes. */
      handle: string;
      clientName: string;
      /** Where the agent's access goes, as the page shows it. */
      sendsTo: string;
      /** True when that is an app on the person's own computer. */
      local: boolean;
    }
  | { kind: 'error'; message: string };

export type ConsentOutcome = { page: Consent; headers: Headers } | { redirect: string };

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

function destination(redirectUri: string): { sendsTo: string; local: boolean } {
  const url = new URL(redirectUri);
  const web = url.protocol === 'https:' || url.protocol === 'http:';
  return { sendsTo: web ? url.host : `${url.protocol}//${url.host}`, local: web && LOOPBACK.test(url.hostname) };
}

// Sends the browser back to the agent with an OAuth error, once the library
// has checked the client and its redirect URI.
function backToAgent(request: AuthRequest | AuthorizationError, error: string, description: string): string {
  const redirect = new URL(request instanceof AuthorizationError ? (request.redirectUri ?? '') : request.redirectUri);
  redirect.searchParams.set('error', error);
  redirect.searchParams.set('error_description', description);
  if (request.state) redirect.searchParams.set('state', request.state);
  if (request.issuer) redirect.searchParams.set('iss', request.issuer);
  return redirect.toString();
}

// The answer when a setting sign-in needs is missing, like the OAuth app's
// client ID, or null when sign-in is set up. The log names the setting.
function notSetUp(): Response | null {
  try {
    oauthApp();
    return null;
  } catch (problem) {
    if (!(problem instanceof SignInNotSetUp)) throw problem;
    console.error(`Sign-in is not set up: ${problem.message}`);
    return text(503, "Sign-in isn't set up on this site yet.");
  }
}

const sendBack = (location: string) => new Response(null, { status: 302, headers: { location, ...NO_STORE } });

// Checks an agent's authorization request, the URL it sent the browser to.
// A request the library can send back to the agent goes back, with the
// error. Any other bad request is answered here, never redirected, since the
// client or its redirect URI can't be trusted.
async function checkAuthorizeRequest(
  request: Request,
): Promise<{ api: OAuthHelpers; authRequest: AuthRequest } | Response> {
  const missing = notSetUp();
  if (missing) return missing;
  const api = oauthApi(siteOrigin(request));
  let authRequest: AuthRequest;
  try {
    authRequest = await api.parseAuthRequest(request);
  } catch (problem) {
    if (problem instanceof AuthorizationError && problem.redirectUri) {
      return sendBack(backToAgent(problem, problem.code, problem.description));
    }
    if (problem instanceof AuthorizationError || problem instanceof CimdFetchError) return text(400, BAD_LINK);
    throw problem;
  }
  // The library lets a client with a secret skip PKCE. MCP asks every client
  // to use it, so every client here does.
  if (!authRequest.codeChallenge) {
    return sendBack(backToAgent(authRequest, 'invalid_request', 'PKCE with S256 is required.'));
  }
  return { api, authRequest };
}

/**
 * Answers GET /oauth/authorize when there is no page to show, before the
 * page renders: the request goes back to the agent, or gets an error. Null
 * means the page renders.
 */
export async function refuseAuthorizeRequest(request: Request): Promise<Response | null> {
  const checked = await checkAuthorizeRequest(request);
  return checked instanceof Response ? checked : null;
}

/**
 * Starts the consent page for an agent's authorization request, from the
 * URL it sent the browser to: the handle for the form, and the headers to
 * send, which set the cookie that binds it to this browser and keep the page
 * out of frames.
 */
export async function openConsent(url: string): Promise<ConsentOutcome> {
  const checked = await checkAuthorizeRequest(new Request(url));
  if (checked instanceof Response) {
    const location = checked.headers.get('location');
    if (location) return { redirect: location };
    return { page: { kind: 'error', message: BAD_LINK }, headers: new Headers(NO_STORE) };
  }
  const { api, authRequest } = checked;
  const client = await api.lookupClient(authRequest.clientId);
  const { handle, headers } = await api.beginConsent(authRequest);
  const page: Consent = {
    kind: 'consent',
    handle,
    clientName: clientNameOf(client?.clientName),
    ...destination(authRequest.redirectUri),
  };
  return { page, headers };
}

// A PKCE verifier for GitHub, and its S256 challenge.
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

async function challengeFor(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

async function gitHubAuthorizeUrl(origin: string, state: string, verifier: string): Promise<string> {
  const url = new URL(`${gitHubUrls().web}/login/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: oauthApp().clientId,
    redirect_uri: `${origin}${MCP_CALLBACK_PATH}`,
    scope: GITHUB_SCOPE,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/**
 * Answers the consent form. Cancel sends the browser back to the agent with
 * access_denied. Approve sends it to GitHub, with a state bound to this
 * browser and a PKCE challenge. The form has to come from the site's own
 * page, and counts toward the sign-in limit.
 */
export async function answerConsent(request: Request): Promise<Response> {
  const origin = siteOrigin(request);
  if (request.headers.get('origin') !== origin) return text(403, 'Refused: this form was sent from another site.');
  if (!(await underSignInLimit(request))) return tooManySignIns();
  const missing = notSetUp();
  if (missing) return missing;
  const form = await request.formData().catch(() => null);
  const handle = form?.get('handle');
  const api = oauthApi(origin);
  try {
    if (typeof handle !== 'string') throw new AuthorizationError('invalid_request', { description: 'No handle' });
    if (form?.get('decision') !== 'approve') {
      const denied = await api.denyConsent(request, handle);
      return new Response(null, { status: 303, headers: denied.headers });
    }
    const approved = await api.approveConsent(request, handle);
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const { state, headers } = await api.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    headers.set('location', await gitHubAuthorizeUrl(origin, state, verifier));
    return new Response(null, { status: 303, headers });
  } catch (problem) {
    if (problem instanceof AuthorizationError) return text(400, START_AGAIN);
    throw problem;
  }
}

/**
 * Where GitHub sends the person back. Trades GitHub's code for their token,
 * reads who they are with it, records the agent in connected_agents, and
 * sends the browser back to the agent with a code for its own tokens. The
 * grant holds the GitHub token in its encrypted props. A new sign-in from
 * the same agent replaces its earlier one, whose GitHub token is revoked.
 */
export async function finishConnecting(request: Request): Promise<Response> {
  if (!(await underSignInLimit(request))) return tooManySignIns();
  const origin = siteOrigin(request);
  const api = oauthApi(origin);
  let resumed: { request: AuthRequest; data: { verifier?: unknown }; headers: Headers };
  try {
    resumed = await api.finishUpstream<{ verifier?: unknown }>(request);
  } catch (problem) {
    if (problem instanceof AuthorizationError) return text(400, START_AGAIN);
    throw problem;
  }
  const { request: authRequest, headers } = resumed;
  const back = (error: string, description: string) => {
    headers.set('location', backToAgent(authRequest, error, description));
    return new Response(null, { status: 302, headers });
  };
  const code = new URL(request.url).searchParams.get('code');
  if (!code || typeof resumed.data.verifier !== 'string') {
    return back('access_denied', "GitHub sign-in didn't finish.");
  }

  const app = oauthApp();
  let gitHubToken: string;
  try {
    gitHubToken = await exchangeGitHubCode(app, {
      code,
      redirectUri: `${origin}${MCP_CALLBACK_PATH}`,
      codeVerifier: resumed.data.verifier,
    });
  } catch (problem) {
    if (!(problem instanceof GitHubError)) throw problem;
    console.error(`GitHub didn't give an agent's sign-in a token: ${failureReason(problem)}`);
    return back('access_denied', "GitHub sign-in didn't finish.");
  }

  // Everything below holds a fresh token. When a step fails, the token is
  // revoked, and so is any connection made with it, since nothing else would
  // ever use them.
  let person: number | null = null;
  let connection: { githubId: number; id: string } | null = null;
  let redirectTo: string;
  try {
    const profile = await gitHubRest<{ id: number; login: string }>(gitHubToken, 'GET', '/user');
    const githubId = profile.id;
    person = githubId;
    const now = Date.now();
    await savePerson(env.DB, { githubId, login: profile.login }, now);
    const client = await api.lookupClient(authRequest.clientId);
    const clientName = clientNameOf(client?.clientName);
    connection = { githubId, id: await addConnection({ githubId, clientId: authRequest.clientId, clientName, gitHubToken }, now) };
    const props: AgentProps = { connectionId: connection.id, githubId, login: profile.login, gitHubToken };
    ({ redirectTo } = await api.completeAuthorization({
      request: authRequest,
      userId: String(githubId),
      metadata: { connectionId: connection.id },
      // Good First Token has no OAuth scopes of its own. A connected agent
      // can call every tool its person can.
      scope: [],
      props,
    }));
  } catch (problem) {
    console.error(`An agent's sign-in failed after GitHub gave a token: ${failureReason(problem)}`);
    const revoked = connection && (await disconnect(origin, connection.githubId, connection.id).catch(() => false));
    if (!revoked && person !== null) await revokeUnlessHeld(origin, person, gitHubToken).catch(() => undefined);
    // GitHub didn't say whose token it is, so nothing the site holds can be
    // checked against it. GitHub gives each sign-in a new token.
    if (!revoked && person === null) await revokeGitHubToken(app, gitHubToken).catch(() => undefined);
    return back('server_error', "Connecting the agent didn't finish. Try again.");
  }
  // The new connection works. Ending the ones it replaced is tidying, so a
  // failure there is logged and the agent still gets its code.
  try {
    await endReplacedConnections(origin, connection.githubId, authRequest.clientId, connection.id);
  } catch (problem) {
    console.error(`An agent's earlier connections weren't ended: ${failureReason(problem)}`);
  }
  headers.set('location', redirectTo);
  return new Response(null, { status: 302, headers });
}
