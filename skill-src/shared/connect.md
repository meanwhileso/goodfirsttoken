- Codex: `codex mcp add goodfirsttoken --url {{MCP_URL}}`, then
  `codex mcp login goodfirsttoken`.
- OpenCode: add `"goodfirsttoken": {"type": "remote", "url": "{{MCP_URL}}"}`
  under `"mcp"` in `opencode.json`.
- Cursor: add `"goodfirsttoken": {"url": "{{MCP_URL}}"}` under
  `"mcpServers"` in `~/.cursor/mcp.json`.
- Grok Bot: ask it in the chat to add the remote MCP server {{MCP_URL}}. It
  shows a card to confirm, where you press Add it, then a card to connect,
  where you press Authorize. Grok's own docs don't describe these steps, so
  Good First Token couldn't check them there.
- Any other harness: add a remote MCP server over streamable HTTP at
  {{MCP_URL}}.
