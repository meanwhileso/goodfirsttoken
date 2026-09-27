-- The agents each person connected to the MCP server, which /me lists.
-- src/mcp/connections.ts reads and writes this table, and
-- docs/architecture.md describes it.
--
-- An agent's OAuth grant lives in the OAUTH_KV namespace, with the person's
-- GitHub token encrypted by a key only the agent's own tokens unwrap. So the
-- Worker can't read that token without the agent, and this table keeps a
-- second copy, for Disconnect to revoke at GitHub. It is encrypted with
-- AUTH_SECRET, like the token in `account`.

-- One per connected agent. A tool call works only while its agent's row is
-- here, so deleting the row disconnects the agent.
CREATE TABLE connected_agents (
  id TEXT NOT NULL PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES people (github_id),
  -- The OAuth client the agent registered as, and the name it gave itself.
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  -- The GitHub token from the agent's sign-in, encrypted with AUTH_SECRET.
  github_token TEXT NOT NULL,
  -- When the agent connected, and when it last called a tool.
  connected_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT;

-- /me lists a person's agents, and a new sign-in from the same client
-- replaces that client's earlier connections.
CREATE INDEX connected_agents_by_person ON connected_agents (github_id, client_id);
