# Architecture

How the pieces fit today, and why the big choices were made. The plan for the
rest is in [specs/v1.md](specs/v1.md). This file changes in the same pull
request as the code it describes.

## The pieces

The repo is a pnpm workspace.

| Path | What it is |
|---|---|
| `apps/web` | One Cloudflare Worker for the whole service. Today it serves a placeholder home page, the design system at `/design`, and `/healthz`. The site, the MCP server, queue consumers, and scheduled jobs all join it here. |
| `packages/core` | Shared schemas and types: project settings, the claim state machine, the input, output, and text of every MCP tool, feed events, and refusal codes. Other packages import its TypeScript source directly, with no build step. |
| `scripts/` | The static server behind `pnpm prototype`, the skill build behind `pnpm skills:build`, and the deploy scripts, with their tests. |
| `skill-src/` | The one source file per skill, and each plugin's version and description. Nothing installs from here. |
| `skills/` | The standalone skills that `npx skills add meanwhileso/goodfirsttoken` installs. Built from `skill-src/`. |
| `plugins/` | The Claude Code plugins, `goodfirsttoken` and `goodfirsttoken-admin`. Each plugin's `skills/` and `.claude-plugin/` folders are built from `skill-src/`. Anything else in a plugin folder is written by hand. The version rule covers the whole folder. |
| `.claude-plugin/marketplace.json` | Makes the repo a Claude Code plugin marketplace that lists both plugins. Built from `skill-src/`. |
| `.github/workflows/` | CI, and the deploy to staging and production. |
| `brand/`, `prototype/`, `video/` | The brand docs, the clickable prototype the site is built from, and the launch video source. |

### apps/web

- **TanStack Start on Vite**, with `@cloudflare/vite-plugin` running the
  server side inside `workerd`, the Workers runtime, in development, in
  tests, and in production.
- **`src/server.ts` is the Worker's entry point.** It answers a request to a
  redirect domain itself, with `src/redirect.ts`, and hands every other
  request to TanStack Start. Queue consumers, cron handlers, and Durable
  Object classes are exported from it as they arrive.
- **Routes live in `src/routes/`,** one file per route. Page routes export a
  component. HTTP endpoints like `/healthz` use `server.handlers`. The
  TanStack Router plugin writes `src/routeTree.gen.ts` on every dev run and
  build. It is committed, so a type check works without a build first.
- **Bindings and variables come from `cloudflare:workers`,** imported as
  `env`, so any module can read them.

### The design system

- **Components are React components in `src/components/`,** one file per
  component, which any route imports. `/design` (`src/routes/design.tsx`)
  shows every one of them with sample data from `src/design/samples.ts`,
  which the end-to-end tests read too. It replaced the prototype's
  design-system page.
- **Styles are plain CSS in `src/styles/`.** `tokens.css` holds the tokens
  from the YAML in `brand/design.md` as CSS variables. `app.css` bundles it
  with the fonts, the base styles, and every component's styles, and the
  root route links it on every page. CSS for one page, like
  `design-page.css`, is linked from that route's `head`.
- **Class names are BEM-style:** a block like `wall-line`, its parts like
  `wall-line__time`, and its variants like `chip--live`. State lives in
  attributes, like `aria-pressed`, `aria-current`, and the token field's
  `data-level`. The layout and text helpers in `base.css`, like `wrap`,
  `stack`, and `mono`, are single words.
- **The fonts are self-hosted.** `src/fonts/` holds the Geist and Geist Mono
  variable fonts from the `geist` npm package, version 1.7.2, under the SIL
  Open Font License in `src/fonts/OFL.txt`. Vite gives each file a content
  hash, the Worker's static assets serve it, and the root route preloads
  both. #33 moves them to the static host.
- **Widths come from containers.** The nav is a container and folds on its
  own width, so the same component works at the top of a page and inside a
  narrower frame. `body` is a container too, and the gutter switches on its
  width. A media query would count the scrollbar, so with a classic
  scrollbar the nav could fold at a different width than the gutter
  switches.

### packages/core

- **Zod 4 for every schema,** with the TypeScript types inferred from them.
  The MCP TypeScript SDK's 1.x line takes zod 3.25 or 4, and its 2.x packages
  and Cloudflare's `agents` package need zod 4, so the MCP server can register
  these schemas as they are.
- **One module per concern.** `primitives.ts` holds the small shapes the
  rest are built from: GitHub logins, repos, issues, labels, and PRs, and our
  IDs, times, and links. `projects.ts` holds projects and their settings,
  `claims.ts` the claim state machine and the stored claim, `feed.ts` feed
  events, `refusals.ts` the refusal codes, and `validation.ts` the check that
  names the field in every problem.
- **Each MCP tool is a spec** in `src/tools/`, one file each for donors,
  maintainers, and admins: who sees it, a description for agents, input and
  output schemas, and a function that renders the output as text.
  `src/tools/index.ts` lists them all, and its `toolResult` and
  `toolRefusal` build MCP results without depending on the MCP SDK.
- **The claim state machine never reads the clock.** Its caller passes the
  time in, in the unit Durable Object alarms use, so an alarm can drive it
  and a test can set any time. The units are in
  [how-it-works.md](how-it-works.md#claims).
- **Limits live in one place.** [how-it-works.md](how-it-works.md#limits)
  lists every cap the schemas enforce, with who set it.

## Skills and plugins

`scripts/skills.mjs` builds every skill from its one source file.
`pnpm skills:build` writes the copies. `pnpm skills:check` fails when a
committed copy is not what the build writes, or when a plugin changed and
its version did not go up.

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
- **Versions.** Each plugin's version is in `skill-src/plugins.json`.
  `pnpm skills:check` compares every file under `plugins/<name>/` with the
  same files at a base commit, read with `git show`. An added or removed
  file counts, and files git ignores are left out. When anything differs,
  the version must be higher than the one the base published. A lower
  version always fails. A plugin the base doesn't have can start at any
  version. The rule covers hand-written files in a plugin folder, like a
  hook, as well as built ones.
- **The base** is `origin/main`, or the ref given with `--base <ref>` or
  `SKILLS_BASE_REF`. A base that can't be found fails the check. Because the
  base is the branch the work merges into, one raise covers every later
  change in the same pull request.
- **In CI** the `test` job checks out two commits and compares with
  `HEAD^1`. For a pull request, the checkout is GitHub's merge commit, so
  `HEAD^1` is the base branch's tip. On a push to main, `HEAD^1` is the
  previous main, which holds for a squash merge and for a merge commit. A
  rebase merge of a pull request with several commits compares only its
  last commit, so it can fail on main after passing on the pull request.
- **The admin plugin** lists `goodfirsttoken` as a dependency and has no MCP
  server of its own. Installing it installs the donor plugin too, so an admin
  connects to the server once.

### What the installers read

- **`npx skills add`** reads `skills/`. We checked version 1.7.0 of the
  `skills` package. It also reads `.claude-plugin/marketplace.json` and
  scans each listed plugin's `skills/` folder, so with nothing more it would
  also offer the plugin copies, the admin skill among them. The plugin
  copies carry `metadata.internal: true`, which it skips by default. So by
  default it installs only `skills/`. Run from a local checkout, it lists
  and installs exactly the four `goodfirsttoken-*` skills. This answers
  [open question 2](specs/v1.md#open-questions).
- **Two ways around that default** install a plugin copy: naming it with
  `--skill`, like `--skill admin` or `--skill give`, and setting
  `INSTALL_INTERNAL_SKILLS=1`. The admin skill holds nothing secret. The
  server checks that the caller is an admin on every admin tool call, which
  #11 builds.
- **Claude Code** reads `.claude-plugin/marketplace.json` and each plugin's
  `.claude-plugin/plugin.json`, and loads each plugin's `skills/` folder.
  It ignores `metadata` in a skill. A plugin from a marketplace added as a
  local folder loads from that folder at each session start. Everyone else
  gets a cached copy, which Claude Code replaces only when the version
  changed. That happens the next time the person updates the plugin or the
  marketplace, or automatically if they turned on auto-update for it.
  Auto-update is off by default for a marketplace added from GitHub, like
  this one.

## Bindings

`apps/web/wrangler.jsonc` is the config for local development. It declares
every binding and variable the Worker reads, under local names. Staging and
production are not in the repo. The deploy writes their config from the
GitHub environment, as [Deploys](#deploys) describes.

| Binding | Kind | Used from |
|---|---|---|
| `ENVIRONMENT` | Variable: `development`, `staging`, or `production` | Now, by `/healthz` |
| `PRIMARY_DOMAIN`, `REDIRECT_DOMAINS` | Variables: the site's domain, and domains that redirect to it | Now, by `src/redirect.ts` |
| `OAUTH_CLIENT_ID` | Variable: the GitHub OAuth app's client ID | #8 |
| `ADMIN_GITHUB_IDS` | Variable: admins' numeric GitHub IDs, separated by commas | #8 |
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
secrets never go in a file. The deploy reads them from the GitHub environment
and writes them into a config file that git ignores. Where an ID is left out,
the deploy or Wrangler creates the resource on the first deploy.

Each secret the Worker reads goes by name under `secrets.required` in
`wrangler.jsonc`, and the deploy puts it. The Worker reads none yet, so the
key is absent. GitHub reserves names that start with
`GITHUB_` for its own variables and secrets, so no variable or secret of the
Worker can start with it.

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
- **Screenshot tests** compare `/design` at 360, 390, 768, 1024, and 1280px
  with the baselines in `apps/web/e2e/design.spec.ts-snapshots/`, with the
  clock paused so the live wall holds still. Up to 2% of pixels may differ,
  for antialiasing, and a change in page height always fails. The baselines
  must come from the Playwright build CI uses, because other Chromium builds
  can wrap text differently. To update them, after a deliberate visual
  change and after every Playwright upgrade, let the `e2e` job fail, take
  each `design-<width>-actual.png` from `test-results/` in the job's
  `playwright-report` artifact, check them by eye, and commit them as the
  baselines.
- **The core package's tests** run with plain Vitest in Node, since the
  package is pure. They live in `packages/core/test/`.
- **The tests for `scripts/`**, the static server, the skill build, and the
  deploy, use Node's own test runner. The deploy's tests fake Cloudflare's
  API, GitHub's OIDC endpoint, and Wrangler, and check the scripts, the
  deploy workflows, and [self-hosting.md](self-hosting.md) against each
  other.

`pnpm test` runs all of them but Playwright. `pnpm test:e2e` runs Playwright.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to
`main`, on GitHub-hosted runners, with a read-only token. It uses no secrets,
so a pull request from a fork runs the same checks as one from a branch.
Every action is pinned to a commit SHA.

| Job | What it runs |
|---|---|
| `test` | `pnpm test`, then `pnpm skills:check` with `HEAD^1` as the base |
| `lint` | `pnpm lint`: ESLint with type-aware rules from typescript-eslint |
| `typecheck` | `pnpm typecheck` |
| `e2e` | `pnpm test:e2e` in Chromium, keeping the report and traces when it fails |
| `leaks` | gitleaks over the full history, with the rules in `.gitleaks.toml` |
| `actionlint` | actionlint over every workflow, with shellcheck on their `run:` scripts |

Branch protection requires `test` and `leaks` by name.

## Deploys

`.github/workflows/deploy.yml` runs on every push to `main`, and by hand. It
calls `deploy-environment.yml` for staging, and then for production. Each
runs only when its repository variable, `DEPLOY_STAGING` or
`DEPLOY_PRODUCTION`, is `true`, so `main` stays green before a deployment is
set up. Each call is one job in the GitHub environment it deploys, and reads
every deployment value from there. [self-hosting.md](self-hosting.md) lists
the settings and the one-time setup.

The job runs these steps. The scripts are in `scripts/`.

1. `pnpm install --frozen-lockfile --ignore-scripts`. esbuild and workerd
   run without their install scripts, and the deploy needs no generated
   types or git hooks.
2. `deploy-config.mjs` reads `wrangler.jsonc` and writes
   `apps/web/wrangler.deploy.json`, which git ignores. It refuses to write
   through a symlink there. It names the Worker `WORKER_NAME` and every other
   resource `<WORKER_NAME>-<local name>`. It copies in each ID that is set
   and leaves out each one that isn't. It sets every variable from the
   setting of the same name, so no local value reaches a deployed Worker, and
   sets `ENVIRONMENT` to the target. It attaches `PRIMARY_DOMAIN` and
   `REDIRECT_DOMAINS` as custom domains and turns workers.dev off when there
   is a domain. It masks the account ID, resource names and IDs, and the value
   of every variable but `ENVIRONMENT` for the later steps, Wrangler's output
   included. A
   key or binding it does not know stops the deploy, so a new kind of binding
   never reaches Cloudflare with its local name.
3. The Vite build reads that file through
   `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`, and writes the config Wrangler
   deploys from.
4. `deploy.mjs credential` puts a Cloudflare token in `$GITHUB_ENV` for the
   later steps: the `CLOUDFLARE_API_TOKEN` secret, or a short-lived token from
   the credential broker, traded for the job's GitHub OIDC token. It masks
   the OIDC token as soon as it has it, and the broker call follows no
   redirects.
5. `deploy.mjs resources` creates each D1 database that has no ID, and each
   queue, dead-letter queues included, when missing. Wrangler would create a
   missing producer queue itself, but not a dead-letter queue, and a database
   has to exist before its migrations run.
6. `deploy.mjs migrations` runs `wrangler d1 migrations apply --remote` for
   each database that has a migrations folder, and skips one that has none.
7. `deploy.mjs secrets` puts each secret in `secrets.required` with
   `wrangler secret put`, one at a time, from the environment secret of the
   same name. The value reaches Wrangler on stdin only.
8. `wrangler deploy`. On the first deploy, Wrangler creates the KV namespace
   when `OAUTH_KV_ID` is empty, and reuses it after that.
9. `deploy.mjs smoke-test` reads `/healthz` on the primary domain, or the
   workers.dev URL Wrangler reported, until it answers ok from the target
   environment. It fails at once if another environment answers, and after
   three minutes otherwise.

Choices:

- **One setting names every resource.** New bindings get deployed names
  without new settings. Only IDs, which Cloudflare assigns, need one each.
- **Settings are read as `secrets.NAME || vars.NAME`,** so each can be
  either. [self-hosting.md](self-hosting.md#settings) says which to use.
- **One reusable workflow runs both environments,** so staging and production
  always run the same steps.
- **The build step runs before the credential step,** so the Cloudflare token
  is not in the build step's environment. That is only the order of steps.
  `id-token: write` covers the whole job, so any step could ask GitHub for an
  OIDC token, and a step can change what later steps run.
- **Deploys run one at a time** in one concurrency group, which never
  cancels a deploy in progress. Deploy jobs have `id-token: write` for the
  broker and read-only contents.

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
  supports. `packages/core` uses the same version.
- **One text block per tool result.** The MCP spec suggests that a tool
  returning structured content also send it as serialized JSON in a text
  block. Ours holds a plain rendering of the result, because terminal
  harnesses show that text to the agent and the donor. The data is already in
  `structuredContent`.
- **The production MCP URL is in the repo.** Installers read the plugin and
  the skills from GitHub, with no environment to supply an address, so the
  URL is part of what we publish. No deploy reads it. Deploy config still
  never names a domain.
- **The skill drift check runs in the `test` job,** which branch protection
  requires, so a hand edit to a generated file blocks the merge.
- **Plugin versions are compared with the base branch.** Nothing a pull
  request edits can get around the rule, and one raise covers the whole
  pull request.
