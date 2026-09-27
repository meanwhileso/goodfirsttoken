import { env } from 'cloudflare:workers';
import type { OAuthApp } from '../github';

// The settings sign-in reads, all from the environment, read on each call so
// a test can change them. A deploy sets ENVIRONMENT to staging or production
// (scripts/deploy-config.mjs), and reads no setting that could change it.

type Settings = Partial<Pick<Env, 'OAUTH_CLIENT_ID' | 'OAUTH_CLIENT_SECRET' | 'AUTH_SECRET' | 'GH_WEB_URL'>>;
const settings = env as Settings;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// GitHub is a GitHub fake on this machine: GH_WEB_URL is http on a loopback
// host. A deploy refuses a GH_WEB_URL that isn't https, and a deployed
// Worker can't reach a loopback address.
function gitHubIsLocalFake(): boolean {
  try {
    const url = new URL(settings.GH_WEB_URL ?? '');
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * True only in local development and the tests that set it up: ENVIRONMENT
 * is development, and GitHub is the GitHub fake on this machine. A deploy is
 * never development, and a Worker deployed some other way can't reach a fake
 * on this machine, so nothing that depends on this can sign anyone in there.
 */
export function isDevelopment(): boolean {
  return env.ENVIRONMENT === 'development' && gitHubIsLocalFake();
}

// Stand-ins for the two secrets, so `pnpm dev` and the browser tests sign in
// with no setup. The client secret is the GitHub fake's own
// (packages/github-fake/src/sample-data.ts), which real GitHub never
// accepts. Both are public, so they apply only in development, and only when
// neither secret is set.
const LOCAL_CLIENT_SECRET = 'local-only-not-a-real-secret';
const LOCAL_AUTH_SECRET = 'local-development-only-auth-secret-not-for-deploys';

/** A setting sign-in needs is missing. The message names it, and never holds a value. */
export class SignInNotSetUp extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInNotSetUp';
  }
}

// Both secrets, or both stand-ins. Setting one secret locally turns the
// stand-ins off, so a real client secret never runs beside a public
// AUTH_SECRET.
function secrets(): { clientSecret: string; authSecret: string } {
  const { OAUTH_CLIENT_SECRET: clientSecret, AUTH_SECRET: authSecret } = settings;
  if (!clientSecret && !authSecret && isDevelopment()) {
    return { clientSecret: LOCAL_CLIENT_SECRET, authSecret: LOCAL_AUTH_SECRET };
  }
  if (!clientSecret) throw missingSecret('OAUTH_CLIENT_SECRET');
  if (!authSecret) throw missingSecret('AUTH_SECRET');
  return { clientSecret, authSecret };
}

function missingSecret(name: string): SignInNotSetUp {
  return new SignInNotSetUp(`The ${name} secret is not set. docs/self-hosting.md lists the Worker's secrets.`);
}

/** The GitHub OAuth app sign-in uses. Throws when its client ID or secret is missing. */
export function oauthApp(): OAuthApp {
  const clientId = settings.OAUTH_CLIENT_ID;
  if (!clientId) throw new SignInNotSetUp('The OAUTH_CLIENT_ID setting is not set. docs/self-hosting.md lists it.');
  return { clientId, clientSecret: secrets().clientSecret };
}

/** Signs sign-in cookies and encrypts stored GitHub tokens. Throws when missing. */
export function authSecret(): string {
  return secrets().authSecret;
}

/**
 * The site's own origin: https on the primary domain when there is one, or
 * the origin the request came to, like workers.dev or localhost.
 */
export function siteOrigin(request: Request): string {
  const primary = env.PRIMARY_DOMAIN.trim().toLowerCase();
  return primary ? `https://${primary}` : new URL(request.url).origin;
}

/**
 * The numeric GitHub IDs of Good First Token's admins, from ADMIN_GITHUB_IDS,
 * separated by commas or spaces. An entry that isn't a whole number names no
 * one.
 */
export function adminGithubIds(): ReadonlySet<number> {
  const ids = (env.ADMIN_GITHUB_IDS as string | undefined) ?? '';
  return new Set(
    ids
      .split(/[\s,]+/)
      .filter((id) => /^[1-9][0-9]{0,15}$/.test(id))
      .map(Number)
      .filter(Number.isSafeInteger),
  );
}
