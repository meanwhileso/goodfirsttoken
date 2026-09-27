import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { env } from 'cloudflare:workers';
import { failureReason, getAuth } from '../auth/auth';
import { authSecret, oauthApp } from '../auth/settings';
import { newId } from '../db/shared';
import { revokeGitHubToken } from '../github';
import { oauthApi } from './provider';

// The agents each person connected to the MCP server, in connected_agents
// (migrations/0003_connected_agents.sql). A grant in OAUTH_KV works only while
// its row is here. The row keeps the GitHub token from the agent's sign-in,
// encrypted with AUTH_SECRET, because the copy in the grant's props opens only
// with the agent's own tokens, and Disconnect has to revoke it without them.

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
}

/** A client names itself when it registers, so its name is cut to this length and never trusted. */
const CLIENT_NAME_MAX = 60;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** The name a client gave itself, as the site shows it: one line, at most 60 characters. */
export function clientNameOf(name: string | undefined): string {
  const line = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return 'An unnamed agent';
  const characters = Array.from(graphemes.segment(line), ({ segment }) => segment);
  return characters.length > CLIENT_NAME_MAX ? `${characters.slice(0, CLIENT_NAME_MAX - 3).join('')}...` : line;
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
