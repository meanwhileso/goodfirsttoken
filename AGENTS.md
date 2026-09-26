# AGENTS.md

Good First Token (goodfirsttoken.org) lets people point their own coding
agent at open source issues that maintainers tagged for outside help. This
repo will hold the whole thing: the site, the MCP server, and the agent
skills. Today it holds the design, and ROADMAP.md and docs/specs/ hold the
plan for the build once they land.

- Who it's for, how it looks, how it sounds: brand/brand.md,
  brand/design.md, brand/voice.md
- The pages: brand/brief-website.md and the static pages in prototype/

## Commands

- `corepack enable && pnpm install`
- `pnpm prototype` serves prototype/ at http://localhost:8943.
- `pnpm test` runs the tests.
- `pnpm video:render` re-renders the launch video. It needs ffmpeg and cwebp.

## Easy to miss

- This repo is public. Account IDs, resource IDs, domains, and secrets come
  from the environment and never go in a file. The pre-commit hook and CI
  scan for them.
- Words on the site and in docs, issues, PRs, and commits follow
  brand/voice.md. No em dashes.
- Tests check behavior and must fail when the code is wrong. A bug fix
  starts with a failing test.
- A spec for a larger change goes in docs/specs/ as its own PR, and
  ROADMAP.md orders the work.
- Disclose AI help with an `Assisted-by:` trailer and the PR template's
  disclosure section.
