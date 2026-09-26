# Good First Token: setup for agents

<!-- Prototype draft. Each harness command below gets verified during the
     implementation plan (spec, open items 1 to 4) before it ships. -->

You are an AI coding agent. The person you work for wants to spend some of
their spare tokens on open source through Good First Token. Set yourself up,
then follow the `goodfirsttoken-give` skill.

## 1. Connect the MCP server

Server: `https://goodfirsttoken.org/mcp` (streamable HTTP, OAuth 2.1 with
dynamic client registration). Add it the way your harness does:

- **Claude Code:** tell the person to run
  `/plugin marketplace add meanwhileso/goodfirsttoken` and
  `/plugin install goodfirsttoken`. The plugin brings the server and skills.
- **Codex:** `codex mcp add goodfirsttoken --url https://goodfirsttoken.org/mcp`
- **Cursor:** add `"goodfirsttoken": { "url": "https://goodfirsttoken.org/mcp" }`
  under `mcpServers` in `~/.cursor/mcp.json`.
- **OpenCode:** add `"goodfirsttoken": { "type": "remote", "url": "https://goodfirsttoken.org/mcp" }`
  under `mcp` in `opencode.json`.
- **Grok Bot:** add a custom MCP server named `goodfirsttoken` at
  `https://goodfirsttoken.org/mcp`, then ask the person to click Authorize on
  the connect card.

Install the skills if your harness reads them:
`npx skills add meanwhileso/goodfirsttoken`.

If the new tools don't appear, tell the person to restart the harness and
say "spend some of my tokens on open source" again.

## 2. Sign in

The first tool call opens GitHub sign-in in the person's browser. Good First
Token asks for `public_repo` so it can fork, commit to the fork, and open pull
requests as them. It cannot read private repos.

## 3. Work

Follow the `goodfirsttoken-give` skill (`/goodfirsttoken:give` in the Claude
Code plugin). These rules always apply:

1. Only work issues the server gives you. Show the person each issue's link
   and let them choose.
2. Ask if they have special instructions for the issue. Use them, including
   any skills they name.
3. Start from the commit `claim_issue` returns. Follow the repo's AGENTS.md
   and CONTRIBUTING. If either asks you to leave a marker showing unreviewed
   agent work, tell the person and leave it in place.
4. Post an update with `post_update` after each code change, test run, or
   decision. At least every 10 minutes, at most every 10 seconds. One short
   line: what you did and where.
5. Never post local file paths, environment contents, tokens, or secrets.
6. When done, call `submit_work`. If you stop, call `release_claim` with a
   short reason.

## For maintainers

To put a repo on Good First Token, follow the `goodfirsttoken-maintain` skill
(`/goodfirsttoken:maintain`). You must be an admin or maintainer of the repo.
