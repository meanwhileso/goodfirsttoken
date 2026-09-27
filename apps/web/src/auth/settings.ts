import { env } from 'cloudflare:workers';
import type { OAuthApp } from '../github';

// The settings sign-in reads, all from the environment, read on each call so
// a test can change them. A deploy sets ENVIRONMENT to staging or production
// (scripts/deploy-config.mjs), and reads no setting that could change it.

/** True only in local development and the tests that set it. A deploy is never development. */
export function isDevelopment(): boolean {
  return env.ENVIRONMENT === 'development';
}

// Stand-ins for the two secrets, so `pnpm dev` and the browser tests sign in
// with no setup. The client secret is the GitHub fake's own
// (packages/github-fake/src/sample-data.ts), which real GitHub never
// accepts. Both are public, so they apply only in development.
const LOCAL_CLIENT_SECRET = 'local-only-not-a-real-secret';
const LOCAL_AUTH_SECRET = 'local-development-only-auth-secret-not-for-deploys';

/** A setting sign-in needs is missing. The message names it, and never holds a value. */
export class SignInNotSetUp extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInNotSetUp';
  }
}

function secret(name: 'OAUTH_CLIENT_SECRET' | 'AUTH_SECRET', local: string): string {
  const value = (env as Partial<Pick<Env, typeof name>>)[name];
  if (value) return value;
  if (isDevelopment()) return local;
  throw new SignInNotSetUp(`The ${name} secret is not set. docs/self-hosting.md lists the Worker's secrets.`);
}

/** The GitHub OAuth app sign-in uses. Throws outside development when its secret is missing. */
export function oauthApp(): OAuthApp {
  return { clientId: env.OAUTH_CLIENT_ID, clientSecret: secret('OAUTH_CLIENT_SECRET', LOCAL_CLIENT_SECRET) };
}

/** Signs sign-in cookies and encrypts stored GitHub tokens. Throws outside development when missing. */
export function authSecret(): string {
  return secret('AUTH_SECRET', LOCAL_AUTH_SECRET);
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
