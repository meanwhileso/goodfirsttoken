import { productName } from '@goodfirsttoken/core';
import { betterAuth, type AuthContext, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import {
  authorizationCodeRequest,
  decryptOAuthToken,
  type OAuth2Tokens,
  type ProviderOptions,
} from 'better-auth/oauth2';
import type { GithubProfile } from 'better-auth/social-providers';
import { env } from 'cloudflare:workers';
import { savePerson } from '../db';
import { GitHubError, gitHubRest, gitHubUrls, revokeGitHubToken, type OAuthApp } from '../github';
import { authSecret, oauthApp } from './settings';

// Sign-in on the site: Better Auth with its GitHub provider, storing users,
// sessions, and GitHub tokens in D1 (migrations/0002_sign_in.sql). Routes in
// routes.ts call it. The rules it follows are in docs/how-it-works.md.

/**
 * The start of every sign-in cookie's name. The __Host- prefix tells the
 * browser the cookie is host-only: Secure, Path=/, and no Domain, so it never
 * reaches another host, like the static host.
 */
export const COOKIE_PREFIX = '__Host-gft';

/** Where Better Auth's routes live, and so its GitHub callback, /auth/callback/github. */
export const AUTH_BASE_PATH = '/auth';

/** The scope sign-in asks GitHub for, and nothing else. */
const GITHUB_SCOPE = 'public_repo';

// Reads who signed in, with the token GitHub just gave, and records them in
// `people` by numeric GitHub ID. Better Auth takes the account's ID from
// `data.id`. Better Auth needs an email for each user. We never ask GitHub
// for one, so each is a placeholder under .invalid.
async function gitHubUserInfo(tokens: OAuth2Tokens) {
  if (!tokens.accessToken) return null;
  let profile: GithubProfile;
  try {
    profile = await gitHubRest<GithubProfile>(tokens.accessToken, 'GET', '/user');
  } catch (error) {
    if (error instanceof GitHubError) return null;
    throw error;
  }
  // Better Auth's type says string. GitHub sends a number.
  const githubId = Number(profile.id);
  await savePerson(env.DB, { githubId, login: profile.login }, Date.now());
  return {
    user: {
      name: profile.login,
      email: `${String(githubId)}@github.invalid`,
      image: profile.avatar_url,
      emailVerified: false,
    },
    data: profile,
  };
}

// Trades the code from GitHub's redirect for a token, at GH_WEB_URL. GitHub
// answers a refused code with 200 and an `error` field. Nothing here logs
// GitHub's answer, since a good one holds the token.
async function exchangeCode(
  web: string,
  options: ProviderOptions,
  input: { code: string; codeVerifier?: string; redirectURI: string },
): Promise<OAuth2Tokens | null> {
  const { body, headers } = await authorizationCodeRequest({ ...input, options });
  const response = await fetch(`${web}/login/oauth/access_token`, {
    method: 'POST',
    body,
    headers: { ...headers, 'user-agent': 'goodfirsttoken' },
    redirect: 'manual',
  });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof data?.access_token !== 'string' || data.error !== undefined) return null;
  return {
    tokenType: 'bearer',
    accessToken: data.access_token,
    scopes: typeof data.scope === 'string' ? data.scope.split(',').filter(Boolean) : [],
  };
}

// Better Auth's GitHub provider sends people to github.com and trades codes
// there. GH_WEB_URL names github.com, which is the GitHub fake in
// development and tests. The authorize URL takes it as an option. This
// plugin sends the code trade there too.
function tradeCodesAt(web: string): BetterAuthPlugin {
  return {
    id: 'github-web-url',
    init: (ctx) => ({
      context: {
        socialProviders: ctx.socialProviders.map((provider) =>
          provider.id === 'github'
            ? { ...provider, validateAuthorizationCode: (input) => exchangeCode(web, provider.options ?? {}, input) }
            : provider,
        ),
      },
    }),
  };
}

/** Why a call failed, for a log: GitHub's status and message, or the kind of error. Never a token. */
export function failureReason(error: unknown): string {
  if (error instanceof GitHubError) return `${String(error.status)} ${error.message}`;
  return error instanceof Error ? error.name : 'an unknown error';
}

// A sign-in replaces the token stored for the person with the new one, and
// nothing else holds the old one, so it is revoked first. Otherwise it would
// stay valid at GitHub, and count toward GitHub's cap of 10 tokens per person
// for the app, which the tokens their agents hold count toward too. When
// GitHub can't revoke it, sign-in goes on.
async function revokeReplacedToken(context: AuthContext, app: OAuthApp, githubId: number): Promise<void> {
  const account = await context.internalAdapter.findAccountByKey({
    providerId: 'github',
    accountId: String(githubId),
  });
  if (!account?.accessToken) return;
  try {
    await revokeGitHubToken(app, await decryptOAuthToken(account.accessToken, context));
  } catch (error) {
    console.error(`GitHub didn't revoke a replaced token at sign-in: ${failureReason(error)}`);
  }
}

// Better Auth's field names, as the snake_case columns in the migration.
const timestamps = { createdAt: 'created_at', updatedAt: 'updated_at' };

function authOptions(origin: string) {
  const { web } = gitHubUrls();
  const app = oauthApp();
  // Better Auth's context for this instance, which the plugin below keeps,
  // for the work sign-in does between reading the person and storing them.
  let context: AuthContext | undefined;
  return {
    appName: productName,
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: authSecret(),
    database: env.DB,
    socialProviders: {
      github: {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        disableDefaultScope: true,
        scope: [GITHUB_SCOPE],
        authorizationEndpoint: `${web}/login/oauth/authorize`,
        disableIdTokenSignIn: true,
        // Keeps the user's name, their login, and avatar current.
        overrideUserInfoOnSignIn: true,
        getUserInfo: async (tokens: OAuth2Tokens) => {
          const info = await gitHubUserInfo(tokens);
          if (info && context) await revokeReplacedToken(context, app, Number(info.data.id));
          return info;
        },
      },
    },
    user: { fields: { emailVerified: 'email_verified', ...timestamps } },
    session: {
      fields: {
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
        ...timestamps,
      },
    },
    account: {
      encryptOAuthTokens: true,
      // D1 has no transactions for Better Auth, so a sign-in that fails
      // between writing the user and their GitHub account leaves a user with
      // no account. Linking lets the next sign-in attach the GitHub account
      // to that user, found by email. Each email is the placeholder made from
      // the numeric GitHub ID, and GitHub is the one way in, so an email
      // matches only the same GitHub account.
      accountLinking: { enabled: true, trustedProviders: ['github'], requireLocalEmailVerified: false },
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        ...timestamps,
      },
    },
    verification: { fields: { expiresAt: 'expires_at', ...timestamps } },
    // A sign-in that fails comes back to the sign-in page with the reason.
    onAPIError: { errorURL: `${origin}/sign-in` },
    advanced: {
      // Better Auth would put __Secure- in front of the names. The __Host-
      // prefix in COOKIE_PREFIX asks for more, and better-call sets Secure
      // and Path=/ and drops any Domain on every cookie named with it.
      useSecureCookies: false,
      cookiePrefix: COOKIE_PREFIX,
      defaultCookieAttributes: { secure: true, path: '/', httpOnly: true, sameSite: 'lax' },
      ipAddress: { disableIpTracking: true },
      // Better Auth skips this check when NODE_ENV is test, so the tests
      // would miss it. Every environment runs it.
      disableOriginCheck: false,
    },
    // Cloudflare's rate limiter guards sign-in (routes.ts). Better Auth's own
    // counts in memory, which each Worker isolate would keep apart.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    plugins: [
      tradeCodesAt(web),
      {
        id: 'goodfirsttoken-context',
        init: (ctx) => {
          context = ctx;
        },
      } satisfies BetterAuthPlugin,
    ],
  } satisfies BetterAuthOptions;
}

function createAuth(origin: string) {
  return betterAuth(authOptions(origin));
}

export type Auth = ReturnType<typeof createAuth>;

// One instance per origin and settings, kept for the isolate's life. Better
// Auth checks the tables on an instance's first request, so each isolate
// checks them once.
const instances = new Map<string, Auth>();

/** Better Auth for the site at `origin`. Throws outside development when a secret is missing. */
export function getAuth(origin: string): Auth {
  const app = oauthApp();
  const key = JSON.stringify([origin, env.ENVIRONMENT, app.clientId, app.clientSecret, authSecret(), gitHubUrls()]);
  let auth = instances.get(key);
  if (!auth) {
    auth = createAuth(origin);
    instances.set(key, auth);
  }
  return auth;
}
