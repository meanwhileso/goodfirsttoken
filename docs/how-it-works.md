# How it works

Every product rule Good First Token follows, as the code does it today. The
plan for what comes next is in [specs/v1.md](specs/v1.md). When a piece of the
plan is built, its rules move here in the same pull request.

Nothing is live yet. The site serves a placeholder home page while the build
goes on in the open.

## Health check

- `GET /healthz` answers `200` with `{"ok": true, "environment": "<name>"}`,
  where the name is `development`, `staging`, or `production`. A deploy's
  smoke test reads it to check that it reached the environment it meant to.
- It reads nothing but the environment name, so it answers even when storage
  or GitHub is down.
- It is sent with `Cache-Control: no-store`, so every check reaches the Worker
  that is live now.

## Skills and plugins

The skills tell an agent how to use Good First Token. Their bodies are
placeholders until #19 and #20 write them.

| Skill | In the Claude Code plugin | Standalone skill |
|---|---|---|
| give | `/goodfirsttoken:give` | `goodfirsttoken-give` |
| work | `/goodfirsttoken:work` | `goodfirsttoken-work` |
| review | `/goodfirsttoken:review` | `goodfirsttoken-review` |
| maintain | `/goodfirsttoken:maintain` | `goodfirsttoken-maintain` |
| admin | `/goodfirsttoken-admin:admin` | Not published |

- The repo is a Claude Code plugin marketplace named `goodfirsttoken`, with
  two plugins. `goodfirsttoken` holds every skill but admin and connects to
  the MCP server at `https://goodfirsttoken.org/mcp`. `goodfirsttoken-admin`
  holds only the admin skill, so donors never see it. Installing it also
  installs `goodfirsttoken`.
- `npx skills add meanwhileso/goodfirsttoken` installs only the standalone
  skills. The admin skill is never among them.
- A plugin's version goes up with every change to its files, so Claude Code
  users receive the change. A version never goes down.
