import { cutGraphemes } from '@goodfirsttoken/core';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { env } from 'cloudflare:workers';
import { failureReason, getAuth } from '../auth/auth';
import { authSecret, oauthApp } from '../auth/settings';
import { newId } from '../db/shared';
import { GitHubError, revokeGitHubToken } from '../github';
import { TOKEN_PATH } from './paths';
import { GRANT_DAYS, grantExists, oauthApi } from './provider';

// The agents each person connected to the MCP server, in connected_agents
// (migrations/0003_connected_agents.sql). A grant in OAUTH_KV works only while
// its row is here: a tool call, trading the code, and a refresh each need it.
// The row keeps the GitHub token from the agent's sign-in, encrypted with
// AUTH_SECRET, because the copy in the grant's props opens only with the
// agent's own tokens, and Disconnect has to revoke it without them. A
// connection ends with its grant, so its token is revoked then too.

/** A connected agent, as /me lists it. Never its token. */
export interface Connection {
  id: string;
  clientName: string;
  connectedAt: number;
  lastUsedAt: number;
}

interface ConnectionRow {
  id: string;
  client_id: string;
  client_name: string;
  github_token: string;
  connected_at: number;
  last_used_at: number;
  grant_id: string | null;
  renewed_at: number | null;
}

/** A client names itself when it registers, so its name is cut to this length and never trusted. */
const CLIENT_NAME_MAX = 60;


/**
 * The name a client gave itself, as the site shows it: one line, at most 60
 * characters, with no control or format characters, like the ones that turn
 * text right to left or take no space.
 */
export function clientNameOf(name: string | undefined): string {
  const line = (name ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!line) return 'An unnamed agent';
  return cutGraphemes(line, CLIENT_NAME_MAX);
}

const encrypt = (token: string) => symmetricEncrypt({ key: authSecret(), data: token });
const decrypt = (stored: string) => symmetricDecrypt({ key: authSecret(), data: stored });

/** Records an agent the person just connected, with their GitHub token from its sign-in. Returns its ID. */
export async function addConnection(
  person: { githubId: number; clientId: string; clientName: string; gitHubToken: string },
  now: number,
): Promise<string> {
  const id = newId('agent');
  await env.DB.prepare(
    `INSERT INTO connected_agents (id, github_id, client_id, client_name, github_token, connected_at, last_used_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(id, person.githubId, person.clientId, person.clientName, await encrypt(person.gitHubToken), now)
    .run();
  return id;
}

/**
 * Records that the agent got tokens at `now`, by trading its code or
 * refreshing, from the grant `grantId`, and says whether it is still
 * connected. The grant runs out 30 days after the last time.
 */
export async function renewConnection(id: string, githubId: number, grantId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    'UPDATE connected_agents SET grant_id = ?3, renewed_at = ?4 WHERE id = ?1 AND github_id = ?2 RETURNING id',
  )
    .bind(id, githubId, grantId, now)
    .first();
  return row !== null;
}

/**
 * Records that the agent called a tool at `now`, and says whether it is still
 * connected. A disconnected agent has no row, so its grant stops working here
 * even before the grant itself is gone.
 */
export async function markConnectionUsed(id: string, githubId: number, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    'UPDATE connected_agents SET last_used_at = MAX(last_used_at, ?3) WHERE id = ?1 AND github_id = ?2 RETURNING id',
  )
    .bind(id, githubId, now)
    .first();
  return row !== null;
}

/** A person's connected agents, the most recently used first. */
export async function listConnections(githubId: number): Promise<Connection[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, client_name, connected_at, last_used_at FROM connected_agents
     WHERE github_id = ? ORDER BY last_used_at DESC, connected_at DESC`,
  )
    .bind(githubId)
    .all<Pick<ConnectionRow, 'id' | 'client_name' | 'connected_at' | 'last_used_at'>>();
  return results.map((row) => ({
    id: row.id,
    clientName: row.client_name,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
  }));
}

// A stored token, or null when it can't be read, as after AUTH_SECRET
// changed.
async function readable(decrypted: Promise<string>): Promise<string | null> {
  try {
    return await decrypted;
  } catch {
    return null;
  }
}

// Deletes the row. Returns whether there was one, and the GitHub token it
// held, or null when that can't be read.
async function removeRow(id: string, githubId: number): Promise<{ token: string | null } | null> {
  const row = await env.DB.prepare('DELETE FROM connected_agents WHERE id = ?1 AND github_id = ?2 RETURNING github_token')
    .bind(id, githubId)
    .first<Pick<ConnectionRow, 'github_token'>>();
  return row ? { token: await readable(decrypt(row.github_token)) } : null;
}

// Deletes the grant in OAUTH_KV that belongs to the connection, so its
// tokens stop working. The grant names its connection in its metadata.
async function revokeGrant(origin: string, githubId: number, connectionId: string): Promise<void> {
  const api = oauthApi(origin);
  const userId = String(githubId);
  let cursor: string | undefined;
  do {
    const page = await api.listUserGrants(userId, cursor === undefined ? {} : { cursor });
    for (const grant of page.items) {
      const metadata = grant.metadata as { connectionId?: unknown } | null;
      if (metadata?.connectionId === connectionId) await api.revokeGrant(grant.id, userId);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
}

// True when something the site still holds uses this GitHub token: the
// person's web sign-in, or another of their agents. GitHub gives a new token
// for each sign-in, so this is a guard. Revoking a shared token would cut
// off the web session or the other agent too.
async function tokenStillHeld(origin: string, githubId: number, token: string, exceptId: string): Promise<boolean> {
  const context = await getAuth(origin).$context;
  const account = await context.internalAdapter.findAccountByKey({ providerId: 'github', accountId: String(githubId) });
  if (account?.accessToken) {
    const webToken = await readable(symmetricDecrypt({ key: context.secretConfig, data: account.accessToken }));
    if (webToken === token) return true;
  }
  const { results } = await env.DB.prepare('SELECT github_token FROM connected_agents WHERE github_id = ?1 AND id != ?2')
    .bind(githubId, exceptId)
    .all<Pick<ConnectionRow, 'github_token'>>();
  for (const row of results) if ((await readable(decrypt(row.github_token))) === token) return true;
  return false;
}

/**
 * Revokes one of a person's GitHub tokens at GitHub, as the OAuth app, unless
 * the site holds it for their own sign-in or for an agent other than
 * `connectionId`. When GitHub can't revoke it, that is logged, naming no
 * token.
 */
export async function revokeUnlessHeld(origin: string, githubId: number, token: string, connectionId = ''): Promise<void> {
  if (await tokenStillHeld(origin, githubId, token, connectionId)) return;
  try {
    await revokeGitHubToken(oauthApp(), token);
  } catch (error) {
    console.error(`GitHub didn't revoke a disconnected agent's token: ${failureReason(error)}`);
  }
}

/**
 * Disconnects one of a person's agents: its row goes, so its next tool call
 * gets a 401, its grant goes, and its GitHub token is revoked at GitHub.
 * Returns false when the person has no such agent. With `revoke` false the
 * token is left alone, for a token GitHub already stopped accepting.
 */
export async function disconnect(
  origin: string,
  githubId: number,
  connectionId: string,
  { revoke = true }: { revoke?: boolean } = {},
): Promise<boolean> {
  const removed = await removeRow(connectionId, githubId);
  if (removed === null) return false;
  // With the row gone, the grant can't make a tool call. Deleting it too is
  // tidying, so a failure here still revokes the token.
  try {
    await revokeGrant(origin, githubId, connectionId);
  } catch (error) {
    console.error(`A disconnected agent's grant wasn't deleted: ${failureReason(error)}`);
  }
  if (revoke && removed.token === null) {
    console.error("A disconnected agent's GitHub token couldn't be read, so it wasn't revoked. Did AUTH_SECRET change?");
  } else if (revoke && removed.token !== null) {
    await revokeUnlessHeld(origin, githubId, removed.token, connectionId);
  }
  return true;
}

/**
 * Ends a person's earlier connections from the same OAuth client, once a new
 * sign-in from that client replaced them. The OAuth library deletes their
 * grants when it stores the new one, so their GitHub tokens would stay
 * working with nothing to use or revoke them. This revokes those, and never
 * the new connection's token.
 */
export async function endReplacedConnections(
  origin: string,
  githubId: number,
  clientId: string,
  keepId: string,
): Promise<void> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM connected_agents WHERE github_id = ?1 AND client_id = ?2 AND id != ?3',
  )
    .bind(githubId, clientId, keepId)
    .all<Pick<ConnectionRow, 'id'>>();
  for (const { id } of results) await disconnect(origin, githubId, id);
}

const MINUTE = 60 * 1000;

// An agent has the library's 10 minutes to trade its code, and its grant
// runs out 30 days after it last got tokens. The minute more keeps this from
// ending a grant the library hasn't.
const CODE_LIFETIME = 10 * MINUTE;
const GRANT_LIFETIME = GRANT_DAYS * 24 * 60 * MINUTE;
const SLACK = MINUTE;

// A connection whose grant ran out, with ?1 the time before which a code
// had to be traded, and ?2 the time before which the agent last got tokens.
const LAPSED = '((renewed_at IS NULL AND connected_at < ?1) OR renewed_at < ?2)';
const lapsedBefore = (now: number) => [now - CODE_LIFETIME - SLACK, now - GRANT_LIFETIME - SLACK] as const;

/**
 * Ends a person's connections whose grants ran out, and revokes their GitHub
 * tokens: one whose agent never traded its code, and one whose agent last
 * got tokens more than 30 days ago. Each token is revoked before its
 * connection ends, and a connection whose token GitHub didn't revoke stays
 * for a later try. /me and each agent's sign-in run it for the person, and
 * the daily job, below, for everyone.
 */
export async function endLapsedConnections(origin: string, githubId: number, now: number): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT id FROM connected_agents WHERE ${LAPSED} AND github_id = ?3`)
    .bind(...lapsedBefore(now), githubId)
    .all<Pick<ConnectionRow, 'id'>>();
  for (const { id } of results) await endLapsedConnection(origin, githubId, id);
}

/**
 * The daily job: ends everyone's connections whose grants ran out, as
 * endLapsedConnections does for one person, whether or not its person
 * comes back. It revokes each token before it ends the connection, and a
 * connection whose token GitHub didn't revoke waits for the next run. It
 * takes at most `limit` in a run, the one that last got tokens earliest
 * first, or for one that never did, the one that connected earliest, and the
 * next run takes the rest. Returns how many it ended.
 */
export async function endEveryLapsedConnection(origin: string, now: number, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, github_id FROM connected_agents WHERE ${LAPSED}
     ORDER BY COALESCE(renewed_at, connected_at), id LIMIT ?3`,
  )
    .bind(...lapsedBefore(now), limit)
    .all<{ id: string; github_id: number }>();
  let ended = 0;
  for (const row of results) {
    try {
      if (await endLapsedConnection(origin, row.github_id, row.id)) ended += 1;
    } catch (error) {
      console.error(`A lapsed connection wasn't ended: ${failureReason(error)}`);
    }
  }
  return ended;
}

/**
 * Ends one lapsed connection, revoking its token first.
 * Disconnect deletes the row first, so the agent is cut off at once, and a
 * failed revoke is only logged. A lapsed grant can't be used, so this can
 * wait for GitHub: when the revoke fails, the row stays for the next try.
 * GitHub's 404 says it no longer knows the token, which counts as revoked.
 * Returns whether the connection ended.
 */
async function endLapsedConnection(origin: string, githubId: number, id: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT github_token FROM connected_agents WHERE id = ?1 AND github_id = ?2')
    .bind(id, githubId)
    .first<Pick<ConnectionRow, 'github_token'>>();
  if (row === null) return false;
  const token = await readable(decrypt(row.github_token));
  if (token === null) {
    console.error("A lapsed connection's GitHub token couldn't be read, so it wasn't revoked. Did AUTH_SECRET change?");
  } else if (!(await tokenStillHeld(origin, githubId, token, id))) {
    try {
      await revokeGitHubToken(oauthApp(), token);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) {
        console.error(`GitHub didn't revoke a lapsed connection's token, so it waits for a later try: ${failureReason(error)}`);
        return false;
      }
    }
  }
  return disconnect(origin, githubId, id, { revoke: false });
}

/**
 * The token an agent asks to revoke, when `request` is a revocation at the
 * token endpoint: a form with a token and no grant_type, as the library reads
 * one. An empty grant_type counts as none there, so it does here too. Null
 * for any other request.
 */
export async function revocationToken(request: Request): Promise<string | null> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== TOKEN_PATH) return null;
  const form = await request
    .clone()
    .formData()
    .catch(() => null);
  const token = form?.get('token');
  return typeof token === 'string' && token !== '' && !form?.get('grant_type') ? token : null;
}

/**
 * Ends the connection whose grant an agent just revoked at the token
 * endpoint, the way Disconnect does, so its GitHub token is revoked too. The
 * library deletes the grant when the agent revokes its refresh token, and
 * keeps it when the agent revokes only an access token. Each token names its
 * person and grant, as <person>:<grant>:<secret>. A failure is logged, since
 * the agent's revocation already worked.
 */
export async function endRevokedConnection(origin: string, token: string): Promise<void> {
  const [person = '', grantId = '', ...rest] = token.split(':');
  const githubId = Number(person);
  if (rest.length !== 1 || grantId === '' || String(githubId) !== person) return;
  try {
    if (await grantExists(person, grantId)) return;
    const row = await env.DB.prepare('SELECT id FROM connected_agents WHERE github_id = ?1 AND grant_id = ?2')
      .bind(githubId, grantId)
      .first<Pick<ConnectionRow, 'id'>>();
    if (row) await disconnect(origin, githubId, row.id);
  } catch (error) {
    console.error(`An agent revoked its grant, and its connection wasn't ended: ${failureReason(error)}`);
  }
}
