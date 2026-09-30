import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { env } from 'cloudflare:workers';
import { AUTH_BASE_PATH, COOKIE_PREFIX, failureReason, GITHUB_SCOPE } from '../auth/auth';
import { tooManySignIns, underRegisterLimit, underSignInLimit, underTokenLimit } from '../auth/rate-limit';
import { sendsCookie } from '../auth/session';
import { oauthApp, SignInNotSetUp, siteOrigin } from '../auth/settings';
import { savePerson } from '../db';
import { exchangeGitHubCode, GitHubError, gitHubRest, gitHubUrls, revokeGitHubToken } from '../github';
import {
  addConnection,
  clientNameOf,
  disconnect,
  endLapsedConnections,
  endReplacedConnections,
  revokeUnlessHeld,
} from './connections';
import { AUTHORIZE_PATH, REGISTER_PATH, TOKEN_PATH } from './paths';
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
//
// No client here is trusted, so a GET /oauth/authorize never redirects. A
// request with an error for the agent gets a page with a link back to it,
// which the person can follow or not. Only the page's own form sends the
// browser to the agent, after the page has shown where it goes.

/** Where GitHub sends the person back, under the OAuth app's callback URL. */
export const MCP_CALLBACK_PATH = `${AUTH_BASE_PATH}/callback/mcp`;

/**
 * The start of the name of the cookie that ties a connection on its way to
 * GitHub to the browser. The library names it with the provider's
 * cookiePrefix (src/mcp/provider.ts), then `upstream-` and part of a hash.
 */
const UPSTREAM_COOKIE = `${COOKIE_PREFIX}.oauth-upstream-`;

function text(status: number, body: string, headers: HeadersInit = {}): Response {
  const answer = new Headers(headers);
  answer.set('content-type', 'text/plain; charset=utf-8');
  answer.set('cache-control', 'no-store');
  return new Response(`${body}\n`, { status, headers: answer });
}

/**
 * Counts the two OAuth requests an agent sends itself, since anyone can send
 * them. A registration stores a client in OAUTH_KV, so it counts toward a
 * limit of the sign-in limit's size, kept apart from sign-ins, since any
 * site's page can send one, and an agent in a web page registers from its
 * own origin. A request to the token endpoint tries a code or a refresh
 * token, and one host can refresh tokens for many people's agents, so it
 * counts toward a limit of its own. The page to approve an agent counts
 * where it starts, in openConsent, and the approval and GitHub's return
 * count where they are answered. Returns the answer for an address over its
 * limit, or null.
 */
export async function limitAgentSignIn(request: Request): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const { pathname } = new URL(request.url);
  if (pathname === REGISTER_PATH && !(await underRegisterLimit(request))) return overOAuthLimit(request);
  if (pathname === TOKEN_PATH && !(await underTokenLimit(request))) return overOAuthLimit(request);
  return null;
}

// The answer over a limit at /oauth/register or /oauth/token, as an OAuth
// error. An agent's SDK reads temporarily_unavailable as one to wait out. It
// reads a body that isn't an OAuth error as a server error, and on a refresh
// that makes it start a new sign-in, which a headless agent can't finish.
// An agent in a web page gets the CORS headers the library sends on its own
// answers here. Without them the browser hides the error, and the SDK takes
// that as a reason to start a new sign-in too.
function overOAuthLimit(request: Request): Response {
  const headers = new Headers({ 'cache-control': 'no-store', 'retry-after': '60' });
  const origin = request.headers.get('origin');
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-expose-headers', 'Retry-After');
    headers.set('vary', 'Origin');
  }
  return Response.json(
    { error: 'temporarily_unavailable', error_description: 'Too many requests from here. Try again in a minute.' },
    { status: 429, headers },
  );
}

const START_AGAIN =
  "This sign-in expired, was already used, or was started in another browser. Connect again from your agent.";

const BAD_LINK = "This link to connect an agent isn't right. Connect again from your agent.";

/** A link back to the agent with the error it should hear, for the person to follow if they choose. */
export interface WayBack {
  /** The agent's redirect URI, with the error. */
  href: string;
  /** Where that goes, as the page shows it. */
  to: string;
  /** What went wrong, in the site's own words for the error. */
  reason: string;
}

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
  | { kind: 'error'; message: string; back: WayBack | null };

/** The page to show, its status, and the headers to send with it. */
export interface ConsentOutcome {
  page: Consent;
  status: number;
  headers: Headers;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/**
 * Why an agent can't register `uri` as a redirect URI, or null when it can.
 * The MCP spec asks for https, or http to this computer. A scheme of an app's
 * own, like cursor://, works too, since desktop apps sign in that way. The
 * library already refuses javascript:, data:, and the like.
 */
export function redirectUriRefusal(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `The redirect URI ${uri} isn't a URL.`;
  }
  if (url.protocol === 'http:' && !LOOPBACK.test(url.hostname)) {
    return 'Use https for a redirect URI, or http on localhost, 127.0.0.1, or [::1].';
  }
  return null;
}

// Where a redirect URI sends the agent's access, as the page shows it: its
// scheme and host. It is on the person's computer when it is http, which
// registration allows only there, or a scheme of an app's own, or https to
// this computer.
function destination(redirectUri: string): { sendsTo: string; local: boolean } {
  const url = new URL(redirectUri);
  return {
    sendsTo: url.host ? `${url.protocol}//${url.host}` : url.protocol,
    local: url.protocol !== 'https:' || LOOPBACK.test(url.hostname),
  };
}

// A link back to the agent with an OAuth error, once the library has checked
// the client and its redirect URI.
function backToAgent(request: AuthRequest | AuthorizationError, error: string, description: string): string {
  const redirect = new URL(request instanceof AuthorizationError ? (request.redirectUri ?? '') : request.redirectUri);
  redirect.searchParams.set('error', error);
  redirect.searchParams.set('error_description', description);
  if (request.state) redirect.searchParams.set('state', request.state);
  if (request.issuer) redirect.searchParams.set('iss', request.issuer);
  return redirect.toString();
}

const NOT_SET_UP = "Sign-in isn't set up on this site yet.";

// True when a setting sign-in needs is missing, like the OAuth app's client
// ID. The log names the setting.
function notSetUp(): boolean {
  try {
    oauthApp();
    return false;
  } catch (problem) {
    if (!(problem instanceof SignInNotSetUp)) throw problem;
    console.error(`Sign-in is not set up: ${problem.message}`);
    return true;
  }
}

// An error page with its status, sent with no-store, and kept out of frames
// like the page itself.
function errorPage(status: number, message: string, back: WayBack | null = null): ConsentOutcome {
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });
  if (status === 429) headers.set('retry-after', '60');
  return { page: { kind: 'error', message, back }, status, headers };
}

// What the page says went wrong, for each OAuth error an agent's request can
// get back. The library's own description repeats parts of the request,
// which anyone can write, so it goes only in the link back to the agent.
const REASONS: Record<string, string> = {
  invalid_request: 'It left out something the request needs, like its PKCE challenge, or sent it wrong.',
  unsupported_response_type: 'It asked for a kind of answer the site never gives. It has to ask for a code.',
  unauthorized_client: "It asked for a kind of answer it didn't register for.",
  invalid_target: "It asked for access to something other than this site's MCP server.",
};
const ANY_REASON = "The site can't use the request as it is.";

// The error page for a request whose error the agent should hear: it says
// what went wrong and links back to the agent.
function wayBack(request: AuthRequest | AuthorizationError, error: string, description: string): ConsentOutcome {
  const href = backToAgent(request, error, description);
  return errorPage(400, "This agent's request to connect isn't right, so nothing was connected.", {
    href,
    to: destination(href).sendsTo,
    reason: REASONS[error] ?? ANY_REASON,
  });
}

// Checks an agent's authorization request, the URL it sent the browser to.
// A request the library could send back to the agent gets a page with a
// link back. Any other bad request gets a page with no link, since its client
// or redirect URI is unknown.
async function checkAuthorizeRequest(
  request: Request,
): Promise<{ api: OAuthHelpers; authRequest: AuthRequest } | ConsentOutcome> {
  if (notSetUp()) return errorPage(503, NOT_SET_UP);
  const api = oauthApi(siteOrigin(request));
  let authRequest: AuthRequest;
  try {
    authRequest = await api.parseAuthRequest(request);
  } catch (problem) {
    if (problem instanceof AuthorizationError && problem.redirectUri) {
      return wayBack(problem, problem.code, problem.description);
    }
    if (problem instanceof AuthorizationError || problem instanceof CimdFetchError) return errorPage(400, BAD_LINK);
    throw problem;
  }
  // The library lets a client with a secret skip PKCE. MCP asks every client
  // to use it, so every client here does.
  if (!authRequest.codeChallenge) return wayBack(authRequest, 'invalid_request', 'PKCE with S256 is required.');
  return { api, authRequest };
}

const OWN_TAB = 'Open this page in a tab of its own, from the link your agent gave you.';

/**
 * False when the browser's Sec-Fetch headers, which a page can't set, say
 * another site's page asked for this, like an image, a frame, or a script's
 * fetch. True for a page loaded in a tab of its own, the site's own page
 * calling the server function behind it, and a request with no
 * Sec-Fetch-Mode at all, from a browser that sends none. Every current
 * browser sends them, on another site's requests too, so a page elsewhere
 * can't take them off.
 */
function openedByPerson(caller: Request): boolean {
  // A speculative prefetch looks like a tab's navigation, but no one opened
  // it. Browsers say so in Sec-Purpose.
  if (/prefetch/i.test(caller.headers.get('sec-purpose') ?? '')) return false;
  const mode = caller.headers.get('sec-fetch-mode');
  if (mode === null) return true;
  if (caller.headers.get('sec-fetch-site') === 'same-origin') return true;
  return mode === 'navigate' && caller.headers.get('sec-fetch-dest') === 'document';
}

/**
 * Starts the page where a person approves an agent, for the request that
 * loads it, with the query string the agent sent. A request the browser
 * says another site's page asked for gets 400 before it counts, so a page
 * elsewhere can't use up someone's sign-ins by loading it in the background.
 * What it answers counts toward the sign-in limit, as the page or
 * on its own. Returns the page, or why there is none, with its status and the
 * headers to send: the cookie that binds the form to this browser, and the
 * two that keep the page out of frames.
 */
export async function openConsent(caller: Request, search: string): Promise<ConsentOutcome> {
  if (!openedByPerson(caller)) return errorPage(400, OWN_TAB);
  if (!(await underSignInLimit(caller))) return errorPage(429, 'Too many sign-ins from here. Try again in a minute.');
  const url = new URL(AUTHORIZE_PATH, siteOrigin(caller));
  url.search = search;
  const checked = await checkAuthorizeRequest(new Request(url));
  if ('page' in checked) return checked;
  const { api, authRequest } = checked;
  const client = await api.lookupClient(authRequest.clientId);
  const { handle, headers } = await api.beginConsent(authRequest);
  const page: Consent = {
    kind: 'consent',
    handle,
    clientName: clientNameOf(client?.clientName),
    ...destination(authRequest.redirectUri),
  };
  return { page, status: 200, headers };
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
  if (notSetUp()) return text(503, NOT_SET_UP);
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
 * When a step after GitHub gave the token fails, the connection is removed
 * and the token revoked, unless the site holds it for something else.
 */
export async function finishConnecting(request: Request): Promise<Response> {
  // A browser with no connection in progress is refused before it counts, as
  // the site's own callback is (src/auth/routes.ts). Such a return fails
  // anyway, and a request another site's page makes in the background never
  // carries the SameSite=Lax cookie that ties a connection to the browser.
  if (!sendsCookie(request, UPSTREAM_COOKIE)) return text(400, START_AGAIN);
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
  // The new connection works. Ending the ones it replaced, and any whose
  // grant ran out, is tidying, so a failure there is logged and the agent
  // still gets its code.
  try {
    await endReplacedConnections(origin, connection.githubId, authRequest.clientId, connection.id);
    await endLapsedConnections(origin, connection.githubId, Date.now());
  } catch (problem) {
    console.error(`An agent's earlier connections weren't ended: ${failureReason(problem)}`);
  }
  headers.set('location', redirectTo);
  return new Response(null, { status: 302, headers });
}
