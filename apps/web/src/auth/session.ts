import { symmetricDecrypt } from 'better-auth/crypto';
import { env } from 'cloudflare:workers';
import { getPerson } from '../db';
import type { Caller } from './permissions';
import { COOKIE_PREFIX, getAuth, type Auth } from './auth';
import { SignInNotSetUp, siteOrigin } from './settings';

/** The person signed in on the site. Their numeric GitHub ID is who they are. */
export interface SignedIn {
  githubId: number;
  /** Their current login, from `people`. */
  login: string;
  /** Better Auth's user for them. */
  userId: string;
}

/** A person's GitHub account in Better Auth, with the token from their last sign-in, encrypted. */
export async function gitHubAccount(auth: Auth, userId: string) {
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(userId);
  return accounts.find((account) => account.providerId === 'github') ?? null;
}

/**
 * The signed-in person as a permission check sees them. Their GitHub token
 * is the one from their last sign-in on the site, decrypted only when a
 * check or an action asks GitHub something as them.
 */
export function siteCaller(signedIn: SignedIn, origin: string): Caller {
  return {
    githubId: signedIn.githubId,
    login: signedIn.login,
    gitHubToken: async () => {
      const auth = getAuth(origin);
      const stored = (await gitHubAccount(auth, signedIn.userId))?.accessToken;
      if (!stored) return null;
      const context = await auth.$context;
      return symmetricDecrypt({ key: context.secretConfig, data: stored });
    },
  };
}

const SESSION_COOKIE = `${COOKIE_PREFIX}.session_token`;

/** True when the request sends a cookie whose name, then `=` and its value, starts with `start`. */
export function sendsCookie(request: Request, start: string): boolean {
  const cookies = request.headers.get('cookie') ?? '';
  return cookies.split(';').some((cookie) => cookie.trim().startsWith(start));
}

function hasSessionCookie(request: Request): boolean {
  return sendsCookie(request, `${SESSION_COOKIE}=`);
}

/**
 * Who is signed in on this request, and any cookies Better Auth set while it
 * checked, like a session it extended or one it found had expired. The caller
 * sends those cookies back with its response. A request with no session
 * cookie reads nothing. When a setting sign-in needs is missing, no one can
 * be signed in, so every page treats the request as signed out.
 */
export async function readSignedIn(request: Request): Promise<{ signedIn: SignedIn | null; setCookies: string[] }> {
  if (!hasSessionCookie(request)) return { signedIn: null, setCookies: [] };
  let auth: Auth;
  try {
    auth = getAuth(siteOrigin(request));
  } catch (error) {
    if (error instanceof SignInNotSetUp) return { signedIn: null, setCookies: [] };
    throw error;
  }
  const { headers, response } = await auth.api.getSession({ headers: request.headers, returnHeaders: true });
  const setCookies = headers.getSetCookie();
  if (!response) return { signedIn: null, setCookies };
  const account = await gitHubAccount(auth, response.user.id);
  const person = account ? await getPerson(env.DB, Number(account.accountId)) : null;
  if (!person) return { signedIn: null, setCookies };
  return { signedIn: { githubId: person.githubId, login: person.login, userId: response.user.id }, setCookies };
}
