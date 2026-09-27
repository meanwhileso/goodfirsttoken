import { env } from 'cloudflare:workers';
import { getPerson } from '../db';
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

const SESSION_COOKIE = `${COOKIE_PREFIX}.session_token`;

function hasSessionCookie(request: Request): boolean {
  const cookies = request.headers.get('cookie') ?? '';
  return cookies.split(';').some((cookie) => cookie.trim().startsWith(`${SESSION_COOKIE}=`));
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
