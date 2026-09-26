# Architecture

How the pieces fit today, and why the big choices were made. The plan for the
rest is in [specs/v1.md](specs/v1.md). This file changes in the same pull
request as the code it describes.

## The pieces

The repo is a pnpm workspace.

| Path | What it is |
|---|---|
| `apps/web` | One Cloudflare Worker for the whole service. Today it serves a placeholder home page and `/healthz`. The site, the MCP server, queue consumers, and scheduled jobs all join it here. |
| `packages/core` | Shared schemas and types. Today it holds only the product name. Other packages import its TypeScript source directly, with no build step. |
| `scripts/` | The static server behind `pnpm prototype` and the skill build behind `pnpm skills:build`, with their tests. |
| `skill-src/` | The one source file per skill, and each plugin's version and description. Nothing installs from here. |
| `skills/` | The standalone skills that `npx skills add meanwhileso/goodfirsttoken` installs. Built from `skill-src/`. |
| `plugins/` | The Claude Code plugins, `goodfirsttoken` and `goodfirsttoken-admin`. Built from `skill-src/`. |
| `.claude-plugin/marketplace.json` | Makes the repo a Claude Code plugin marketplace that lists both plugins. Built from `skill-src/`. |
| `brand/`, `prototype/`, `video/` | The brand docs, the clickable prototype the site is built from, and the launch video source. |

### apps/web

- **TanStack Start on Vite**, with `@cloudflare/vite-plugin` running the
  server side inside `workerd`, the Workers runtime, in development, in
  tests, and in production.
- **`src/server.ts` is the Worker's entry point.** It hands every request to
  TanStack Start. Queue consumers, cron handlers, and Durable Object classes
  are exported from it as they arrive.
- **Routes live in `src/routes/`,** one file per route. Page routes export a
  component. HTTP endpoints like `/healthz` use `server.handlers`. The
  TanStack Router plugin writes `src/routeTree.gen.ts` on every dev run and
  build. It is committed, so a type check works without a build first.
- **Bindings and variables come from `cloudflare:workers`,** imported as
  `env`, so any module can read them.

## Skills and plugins

`scripts/skills.mjs` builds every skill from its one source file.
`pnpm skills:build` writes the copies, and `pnpm skills:check` fails when a
committed copy is not what the build writes.

| Source | Becomes |
|---|---|
| `skill-src/<name>.md` with `plugin: goodfirsttoken` | `skills/goodfirsttoken-<name>/SKILL.md`, and `plugins/goodfirsttoken/skills/<name>/SKILL.md` |
| `skill-src/<name>.md` with `plugin: goodfirsttoken-admin` | `plugins/goodfirsttoken-admin/skills/<name>/SKILL.md` only |
| `skill-src/plugins.json` | Each plugin's `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` |

- **A source file** starts with frontmatter that sets `description` and
  `plugin`, one top-level key per line. Other keys, like `argument-hint`,
  are copied into both copies as written. The build sets `name`, and
  `{{MCP_URL}}` in the body becomes the MCP server's URL.
- **The copies are committed,** because installers read them straight from
  GitHub. `skills/`, `.claude-plugin/`, and each plugin's `skills/` and
  `.claude-plugin/` folders hold only what the build writes, and the build
  removes anything else there.
- **The MCP server URL is set once,** as `PRODUCTION_MCP_URL` in
  `scripts/skills.mjs`. The plugin's server config is
  `${GOODFIRSTTOKEN_MCP_URL:-<that URL>}`, which Claude Code expands when it
  starts the server, so setting the variable points an installed plugin at
  another server. Building with the variable set writes copies for that
  server, such as `http://localhost:5173/mcp` for `pnpm dev`.
  `pnpm skills:check` always compares with a production build, so those
  copies fail CI.
- **Versions.** Each plugin's version is in `skill-src/plugins.json`. The
  build records the version and a SHA-256 of the files it writes into the
  plugin, less the version itself, in `skill-src/plugins.lock.json`. When
  those files change and the version does not go up, the build and the
  check fail. A local build leaves the record alone. A plugin file the build
  does not write, like a future hook, is not in the hash, so a change to it
  needs the version raised by hand.
- **The admin plugin** lists `goodfirsttoken` as a dependency and has no MCP
  server of its own. Installing it installs the donor plugin too, so an admin
  connects to the server once.

### What the installers read

- **`npx skills add`** (the `skills` package, checked at 1.7.0) reads
  `skills/`. It also reads `.claude-plugin/marketplace.json` and scans each
  listed plugin's `skills/` folder, so with nothing more it would also offer
  the plugin copies, the admin skill among them. The plugin copies set
  `metadata.internal: true`, which it skips, so it installs only `skills/`.
  Run from a local checkout, it lists and installs exactly the four
  `goodfirsttoken-*` skills. This answers
  [open question 2](specs/v1.md#open-questions). With
  `INSTALL_INTERNAL_SKILLS=1` it lists the plugin copies as well.
- **Claude Code** reads `.claude-plugin/marketplace.json` and each plugin's
  `.claude-plugin/plugin.json`, and loads each plugin's `skills/` folder.
  It ignores `metadata` in a skill. A plugin from a marketplace added as a
  local folder loads from that folder at each session start. Everyone else
  gets a cached copy that changes only when the version does.

## Bindings

`apps/web/wrangler.jsonc` is the config for local development. It declares
every binding the Worker reads, under local names. Staging and production are
not in the repo. The deploy workflow (#32) will write their config from the
GitHub environment's variables, including the resource names and IDs.

| Binding | Kind | Used from |
|---|---|---|
| `ENVIRONMENT` | Variable: `development`, `staging`, or `production` | Now, by `/healthz` |
| `DB` | D1 | #5 |
| `OAUTH_KV` | KV, for OAuth grants | #9 |
| `FEED_QUEUE` | Queue producer | #14 |
| `CRAWL_QUEUE` | Queue producer | #30 |

The feed's dead-letter queue arrives with the feed consumer in #14, and the
static host's R2 bucket with #33. Durable Objects, cron triggers, and rate
limiters arrive with the issues that use them.

## Configuration and secrets

The repo is public, so `wrangler.jsonc` holds bindings and settings only. The
names of deployed resources, account IDs, resource IDs, custom domains, and
secrets never go in a file. The deploy workflow (#32) will write them into
the final config from the GitHub environment's variables. Where an ID is left
out, Wrangler provisions the resource on the first deploy.

Local development needs none of it. `pnpm dev` runs the Worker in Miniflare,
which simulates every binding and keeps D1 and KV data on disk under
`apps/web/.wrangler/`. The variables the app reads, with safe local defaults,
are listed in `apps/web/.dev.vars.example`.

## Types

TypeScript is strict in every package, with shared settings in
`tsconfig.base.json`.

`wrangler types` writes `apps/web/worker-configuration.d.ts`: the `Env` type
for the bindings in `wrangler.jsonc`, and the Workers runtime types for its
compatibility date. Variables are typed as strings, because the deployed
values come from outside the file. `pnpm install` runs it. The file is not
committed, because it is 600 KB and its header carries a 32-character hash
that the leak scan cannot tell from a Cloudflare ID. `pnpm typecheck` fails
when the file no longer matches `wrangler.jsonc`, and `pnpm install` brings
it up to date.

`apps/web/tsconfig.json` covers the Worker and its tests.
`apps/web/tsconfig.node.json` covers the config files and the Playwright
tests, which run in Node.

## Tests

The rules for tests are in [CONTRIBUTING.md](../CONTRIBUTING.md#tests).

- **Unit and integration tests** run with Vitest inside `workerd`, through
  `@cloudflare/vitest-pool-workers`, with the bindings from `wrangler.jsonc`.
  They call the whole Worker through `exports.default.fetch` from
  `cloudflare:workers`, so a test sees the same routing and headers a
  browser does. They live in `apps/web/test/`.
- **End-to-end tests** run with Playwright against the production build,
  served by `vite preview` inside `workerd`. They live in `apps/web/e2e/`.
- **The tests for `scripts/`**, the static server and the skill build, use
  Node's own test runner.

`pnpm test` runs the first and last. `pnpm test:e2e` runs Playwright.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to
`main`, on GitHub-hosted runners, with a read-only token. It uses no secrets,
so a pull request from a fork runs the same checks as one from a branch.
Every action is pinned to a commit SHA.

| Job | What it runs |
|---|---|
| `test` | `pnpm test`, then `pnpm skills:check` |
| `lint` | `pnpm lint`: ESLint with type-aware rules from typescript-eslint |
| `typecheck` | `pnpm typecheck` |
| `e2e` | `pnpm test:e2e` in Chromium, keeping the report and traces when it fails |
| `leaks` | gitleaks over the full history, with the rules in `.gitleaks.toml` |

Branch protection requires `test` and `leaks` by name.

## Choices

- **One Worker for everything.** The site, the MCP server, and the background
  jobs share one deploy, one set of bindings, and one runtime to test in.
- **Tests run in `workerd`,** the Workers runtime, so a test sees the same
  `fetch`, streams, and crypto the Worker does. The unit tests use the
  `workerd` that `@cloudflare/vitest-pool-workers` pins, which can be older
  than the one dev and preview use. That caps the compatibility date in
  `wrangler.jsonc` at the newest date the pinned one supports.
- **TypeScript 6.** typescript-eslint does not yet support TypeScript 7, and
  type-aware lint rules like `no-floating-promises` catch real bugs in
  Workers code.
- **Vitest 4.1.** It is the newest line `@cloudflare/vitest-pool-workers`
  supports.
- **The production MCP URL is in the repo.** Installers read the plugin and
  the skills from GitHub, with no environment to supply an address, so the
  URL is part of what we publish. No deploy reads it. Deploy config still
  never names a domain.
- **The skill drift check runs in the `test` job,** which branch protection
  requires, so a hand edit to a generated file blocks the merge.
