# AGENTS.md

Good First Token (goodfirsttoken.org) lets people point their own coding
agent at open source issues that maintainers tagged for outside help. This
repo will hold the whole thing: the site, the MCP server, and the agent
skills. Today it holds the design and the workspace the build starts from.
docs/specs/v1.md is the plan for the build, and ROADMAP.md orders it into
issues, one per session. docs/how-it-works.md and docs/architecture.md
describe the code as it is.

- Who it's for, how it looks, how it sounds: brand/brand.md,
  brand/design.md, brand/voice.md
- The pages: brand/brief-website.md and the static pages in prototype/

## Commands

- `corepack enable && pnpm install`
- `pnpm dev` serves the site at http://localhost:5173, with no accounts and
  no network.
- `pnpm check` runs lint and typecheck.
- `pnpm test` runs the unit tests, the Worker's inside the Workers runtime.
- `pnpm test:e2e` runs the Playwright tests against a production build. Run
  `pnpm exec playwright install chromium` once first.
- `pnpm prototype` serves prototype/ at http://localhost:8943.
- `pnpm video:render` re-renders the launch video. It needs ffmpeg and cwebp.

## Easy to miss

- This repo is public. Secrets, account IDs, resource IDs, and the names of
  deployed resources never go in a file, and deployment domains never go in
  config. They come from the environment. The pre-commit hook and CI scan for
  secrets and IDs.
- Commits, PRs, and issues never link to an agent's session. Session links
  are private.
- `pnpm install` generates the Worker's types from apps/web/wrangler.jsonc.
  Run it again after changing that file, or `pnpm typecheck` fails.
- Words on the site and in docs, issues, PRs, and commits follow
  brand/voice.md. No em dashes.
- Tests check behavior and must fail when the code is wrong. A bug fix
  starts with a failing test.
- A spec for a larger change goes in docs/specs/ as its own PR, and
  ROADMAP.md orders the work.
- Disclose AI help with an `Assisted-by:` trailer and the PR template's
  disclosure section.
