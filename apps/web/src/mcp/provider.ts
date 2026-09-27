import {
  getOAuthApi,
  OAuthError,
  OAuthProvider,
  type ClientRegistrationCallbackOptions,
  type ClientRegistrationCallbackResult,
  type OAuthHelpers,
  type OAuthProviderOptions,
  type TokenExchangeCallbackOptions,
} from '@cloudflare/workers-oauth-provider';
import { productName } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { redirectUriRefusal } from './authorize';
import { renewConnection } from './connections';
import { AUTHORIZE_PATH, MCP_PATH, REGISTER_PATH, TOKEN_PATH } from './paths';
import { handleMcpRequest } from './server';

// The MCP server's OAuth 2.1 side, from @cloudflare/workers-oauth-provider,
// as Cloudflare's remote-mcp-github-oauth example sets it up. The library
// answers the protocol's own routes: both metadata documents, dynamic client
// registration, and the token endpoint. It checks the access token on every
// request to /mcp, and passes the grant's props to src/mcp/server.ts. Every
// other request goes to the site. Two callbacks add the site's rules: a
// client registers only redirect URIs the site will send a code to, and an
// agent gets tokens only while its connection is in connected_agents.
// Grants, clients, and tokens live in the OAUTH_KV namespace, which holds
// only hashes of tokens, and the props encrypted with a key that only the
// agent's own tokens can unwrap. src/mcp/authorize.ts has the page where a
// person approves an agent, and the sign-in with GitHub after it.

/**
 * What a grant carries for its agent, encrypted: who the person is, their
 * GitHub token from the agent's sign-in, and the connection in
 * connected_agents that the grant belongs to.
 */
export interface AgentProps {
  connectionId: string;
  githubId: number;
  /** Their login when the agent signed in. */
  login: string;
  gitHubToken: string;
}

const DAY = 24 * 60 * 60;

/**
 * A grant lasts 30 days from the agent's sign-in, and each time the agent
 * refreshes its token it lasts 30 days from then. So an agent in use stays
 * connected, and one left unused for 30 days signs in again.
 */
export const GRANT_DAYS = 30;

// Refuses a client that names a redirect URI the site won't send a code to.
function checkRegistration({ clientMetadata }: ClientRegistrationCallbackOptions): ClientRegistrationCallbackResult | undefined {
  const uris: unknown[] = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
  for (const uri of uris) {
    const refusal = typeof uri === 'string' ? redirectUriRefusal(uri) : null;
    if (refusal) return { code: 'invalid_redirect_uri', description: refusal };
  }
  return undefined;
}

// Runs each time an agent gets tokens, by trading its code or refreshing.
// It needs the agent's connection, and records when, since the grant runs
// out 30 days later. A disconnected agent gets invalid_grant, and the
// library deletes its grant.
async function renewGrant({ props, grantId }: TokenExchangeCallbackOptions): Promise<void> {
  const { connectionId, githubId } = props as AgentProps;
  if (!(await renewConnection(connectionId, githubId, grantId, Date.now()))) {
    throw new OAuthError('invalid_grant', { description: 'This agent was disconnected. Sign in again.' });
  }
}

function options(origin: string, defaultHandler: ExportedHandler<Env>): OAuthProviderOptions<Env> {
  return {
    apiRoute: MCP_PATH,
    apiHandler: { fetch: handleMcpRequest },
    defaultHandler,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    clientRegistrationCallback: checkRegistration,
    tokenExchangeCallback: renewGrant,
    refreshTokenTTL: GRANT_DAYS * DAY,
    refreshTokenIdleTTL: GRANT_DAYS * DAY,
    // The consent page's and the GitHub redirect's cookies. The library
    // names each one with this prefix, which has to start with __Host-, and
    // makes it Secure, host-only, and Path=/, like the site's own.
    cookiePrefix: '__Host-gft.oauth-',
    resourceMetadata: { resource: `${origin}${MCP_PATH}`, resource_name: productName },
  };
}

// The library needs the resource's full URL when it starts, and the site's
// origin comes from the request when there is no primary domain, as on
// workers.dev and in development. So there is one provider per origin, kept
// for the isolate's life.
const providers = new Map<string, OAuthProvider<Env>>();

/** The OAuth provider for the site at `origin`, which hands every request it doesn't answer to `site`. */
export function mcpProvider(origin: string, site: ExportedHandler<Env>): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider(options(origin, site));
    providers.set(origin, provider);
  }
  return provider;
}

const noSite: ExportedHandler<Env> = { fetch: () => new Response(null, { status: 404 }) };

/** The library's helpers for the site at `origin`: consent, the GitHub redirect, grants, and clients. */
export function oauthApi(origin: string): OAuthHelpers {
  return getOAuthApi(options(origin, noSite), env);
}

/**
 * Whether a person's grant is still in OAUTH_KV, where the library keeps
 * each one under grant:<user ID>:<grant ID>. The helpers have no lookup by
 * ID, and listing a person's grants can miss one made in the last minute.
 */
export async function grantExists(userId: string, grantId: string): Promise<boolean> {
  return (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`)) !== null;
}
