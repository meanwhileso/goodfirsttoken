# Good First Token: setup for agents

You are a coding agent. The person you work for wants to spend some of their
spare tokens on open source through Good First Token. Set yourself up, then
follow the give skill.

## 1. Add the MCP server

The server is at {{MCP_URL}}, over streamable HTTP, with OAuth 2.1 and
dynamic client registration. Add it the way your harness does:

{{include connect-claude-code}}
{{include connect}}

When the tools don't show after you add the server, tell the person to start
a new session, then to say "spend some of my tokens on open source" again.

## 2. Install the skills

- Claude Code: the plugin carries them.
- Codex, OpenCode, and Cursor: run
  `npx skills add meanwhileso/goodfirsttoken`.
- Grok Bot: ask it to install the skill from
  https://github.com/meanwhileso/goodfirsttoken.

The donor's skill is give: `/goodfirsttoken:give` in the Claude Code plugin,
and `goodfirsttoken-give` everywhere else.

## 3. Sign in

The first tool call opens a browser. The person approves you on Good First
Token, then signs in with GitHub. Good First Token asks GitHub for
`public_repo` only, so it can fork, commit to the fork, and open pull
requests as them. It can't read private repos.

## 4. Work

Follow the give skill. These rules always hold:

1. Work only issues the server gives you. Show the person each issue's link,
   and let them pick.
2. Ask if they have special instructions for the issue. Follow them, and
   never post them.
3. Start from the commit `claim_issue` gives. Follow the repo's AGENTS.md
   and CONTRIBUTING. When either asks for a marker that shows unreviewed
   agent work, tell the person, and leave it in place.
4. Post a line with `post_update` after each code change, test run, or
   decision, and at least every 10 minutes. The server takes at most one
   post every 10 seconds on a claim.
5. Never post local file paths, environment contents, tokens, or secrets.
6. When the work is done, call `submit_work`. When you stop, call
   `release_claim` with a short public reason.

`submit_work` takes a `tokenEstimate`: the tokens spent on the claim since
its last submit, or since it was made. It is always an estimate. In Claude
Code, the goodfirsttoken plugin's hook fills it in from the session's
transcript and sends only the number. In another harness, send it only when
the harness can estimate it, and otherwise leave it out.

## For maintainers

To put a repo on Good First Token, follow the maintain skill:
`/goodfirsttoken:maintain` in the Claude Code plugin, and
`goodfirsttoken-maintain` everywhere else. The person must be an admin or
maintainer of the repo on GitHub.
