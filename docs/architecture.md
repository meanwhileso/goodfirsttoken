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
| `packages/github-fake` | A fake GitHub for tests and local development, and the sample people and repos. It records whose token made each call. Only tests and dev tooling import it. |
| `scripts/` | The static server behind `pnpm prototype`, the static host's stand-in for the end-to-end tests, the skill build behind `pnpm skills:build`, the deploy scripts, and the check for advisories a pull request adds, with their tests. |
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
- **`src/github.ts` makes every call to GitHub,** REST and GraphQL, at the
  base URL in `GH_API_URL`, or `https://api.github.com` when that is empty.
  Each call takes the token it runs with as an argument. There is no
  default token.

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
  hash, [the static host](#the-static-host) serves it, and the root route
  preloads both.
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
`GH_API_URL` and `GH_WEB_URL` hold the GitHub fake's URLs locally. A deploy
that leaves their settings empty gives them empty strings, and
`src/github.ts` then calls GitHub itself.

| Binding | Kind | Used from |
|---|---|---|
| `ENVIRONMENT` | Variable: `development`, `staging`, or `production` | Now, by `/healthz` |
| `PRIMARY_DOMAIN`, `REDIRECT_DOMAINS` | Variables: the site's domain, and domains that redirect to it | Now, by `src/redirect.ts` |
| `OAUTH_CLIENT_ID` | Variable: the GitHub OAuth app's client ID | #8 |
| `ADMIN_GITHUB_IDS` | Variable: admins' numeric GitHub IDs, separated by commas | #8 |
| `GH_API_URL` | Variable: GitHub's REST and GraphQL API. The GitHub fake locally. Empty means `https://api.github.com` | Now, by `src/github.ts` |
| `GH_WEB_URL` | Variable: github.com itself, for OAuth sign-in. The GitHub fake locally. Empty means `https://github.com` | Now, by `src/github.ts`, for #8 |
| `DB` | D1 | #5 |
| `OAUTH_KV` | KV, for OAuth grants | #9 |
| `FEED_QUEUE` | Queue producer | #14 |
| `CRAWL_QUEUE` | Queue producer | #30 |

The feed's dead-letter queue arrives with the feed consumer in #14. Durable
Objects, cron triggers, and rate limiters arrive with the issues that use
them. The static host's R2 bucket is not a binding, since the Worker never
reads it. [The static host](#the-static-host) covers it.

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
`apps/web/.wrangler/`. It also starts the GitHub fake at
`http://127.0.0.1:8944`, which `wrangler.jsonc` points the Worker at. The
variables the app reads, with safe local defaults, are listed in
`apps/web/.dev.vars.example`.

## The static host

Pages load the built files from a static host: an R2 bucket behind a
Cloudflare custom domain, on a hostname the site doesn't use. Cloudflare's
cache keeps the files at the edge, and the site's cookies never reach them.
A deployment without one serves the same files from the Worker.

- **The build sets every URL.** `apps/web/vite.config.ts` reads
  `STATIC_ORIGIN` from its environment and makes it Vite's `base`. So the
  scripts, the styles, the fonts they name, TanStack Start's manifest, and
  each `?url` import point at that origin, in the HTML the Worker renders
  and in the files themselves. Unset, `base` is `/`, as in `pnpm dev`. The
  Worker never reads the setting, and each environment's build gets its
  own.
- **What goes there.** Everything under `dist/client/assets/`, which holds
  only files Vite names after their content. A plugin in `vite.config.ts`
  adds every file in `src/assets/` to the build, so the launch video and
  its poster are there before a page links to them. A page that imports one
  with `?url` gets the same file. The Worker's static assets hold the same
  files, so emptying `STATIC_ORIGIN` again needs nothing else.
- **The upload.** `scripts/deploy.mjs static-assets` runs after the build
  and before `wrangler deploy`, with Cloudflare's API. It checks that the
  bucket, `<WORKER_NAME>-static`, exists. Then it asks R2 for each file by
  its path and uploads each one R2 doesn't have, with its content type and
  `Cache-Control: public, max-age=31536000, immutable`. R2 sends both back
  with the file. `scripts/static-host.mjs` lists the files and their
  headers for the upload and for the tests' stand-in alike. The upload
  never deletes a file, and never creates the bucket, whose custom domain
  is attached by hand.
- **Fonts and scripts load across origins.** A browser fetches fonts and
  module scripts in CORS mode, so the static host has to send
  `Access-Control-Allow-Origin`. A response header rule on its hostname
  adds `*`. R2's own CORS policy sends the header only when a request
  carries an `Origin`, so a copy Cloudflare cached for another request
  could lack it. Stylesheets load without CORS, so a page keeps its styles
  if the header goes missing.
- **Byte ranges** are R2's own. Nothing in the repo adds them.

## The GitHub fake

`packages/github-fake` answers the GitHub calls the app makes, from state
built from the sample data. Tests import it and run it in-process. `pnpm dev`
and Playwright run it as a local HTTP server.

- **What it covers.** REST: the authenticated user and users, repos with the
  caller's `permissions`, labels, issues and their timelines, issue and repo
  search, file contents, forks, branches and refs, pull requests, reviews,
  and review comments. GraphQL: `repository`, `viewer`, file reads with
  `object(expression:)` across many repos in one query, and
  `createCommitOnBranch`. The OAuth web flow: the authorize page and the
  token endpoint, with PKCE. Each route in `src/rest.ts` names its page on
  docs.github.com, and GitHub's errors come back in GitHub's shape.
- **It records whose token made each call.** `fake.calls` lists every call
  with its endpoint, the token it carried, the login that token belongs to,
  and the status. The local server lists them at `/_fake/calls`.
- **It behaves like GitHub where the app depends on it.** Writes need push
  access. A fork belongs to whoever's token made it, and forking again
  returns the same fork. `createCommitOnBranch` refuses a stale expected
  head, makes the caller the author, and GitHub signs the commit. A PR that
  mentions an issue adds a `cross-referenced` event to that issue's
  timeline, and merging it closes the issues it says it closes. A PR's head
  must be the base repo or a fork of it. Search serves the first 1,000
  results and answers a page past them with a 422. API calls need a
  User-Agent.
- **Where it differs.** Tests that depend on any of these need the fake
  changed first.
  - Forks are ready at once. GitHub makes them in the background.
  - OAuth scopes are recorded and sent back in `x-oauth-scopes`, and
    nothing checks them. A token with no scopes can fork and commit.
  - An archived repo accepts writes.
  - `maintainer_can_modify` is kept and sent back, and the base repo's
    maintainers still can't push to the PR's branch.
  - Issue search refuses a query that names neither `is:issue` nor
    `is:pull-request`, a rule stricter than GitHub's.
  - A search qualifier it doesn't know gets a 422 naming the file to add it
    to. GitHub would read it as text.
  - A `localhost` OAuth callback allows any port, like GitHub's rule for
    `127.0.0.1`.
  - Git object IDs are 40 hex characters made with an FNV hash of the
    content, so they never match a real repo's. The fake can't be cloned
    with `git`.
- **Nothing in it touches the network.** In a test, `fake.fetch` stands in
  for the global `fetch` and throws for any URL outside the fake's two base
  URLs, which default to hosts under `.test`, a domain that never resolves.
  Every URL in its responses, including avatars and raw files, points back
  at the fake.
- **The sample data** in `src/sample-data.ts` takes the shapes of the
  prototype's: donors and maintainers, a project with tagged issues, one
  with nothing tagged, a popular repo that invites contributions, and a
  registration waiting for an admin. It is the one place later issues add
  to. Every account and repo in it is made up, under `sample-owner`, except
  this project's own repo. That repo's sample issues and PRs are numbered
  from 900 up, clear of its real ones.
- **Local sign-in.** The fake's authorize page lists the sample people. Pick
  one, and the app gets that person's token through the same OAuth flow it
  uses with GitHub.
- **Local state.** The server `pnpm dev` starts keeps its state in
  `apps/web/.wrangler/github-fake/state.json`, next to Miniflare's, so forks
  and commits survive a restart. `pnpm seed` resets it to the sample data.
  In CI, Playwright starts a fresh fake with the sample data. Locally it
  reuses a fake that is already running, like the one `pnpm dev` started,
  with whatever state that one has.
- **It never ships.** `apps/web` lists it as a dev dependency, and a lint
  rule refuses an import of it from `apps/web/src`.

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
  browser does. Code no route uses yet, like `src/github.ts`, is called
  directly. They live in `apps/web/test/`. A test that calls GitHub creates
  the GitHub fake in-process and puts `fake.fetch` in place of the global
  `fetch`. `vitest.config.ts` points GitHub's URLs at hosts under `.test`.
- **End-to-end tests** run with Playwright against the production build,
  served by `vite preview` inside `workerd`, beside the GitHub fake's local
  server. They live in `apps/web/e2e/`.
- **The static host in end-to-end tests** is a stand-in,
  `scripts/static-host.mjs`, at `http://127.0.0.1:4174`, a different host
  from the site's `localhost:4173`. The build under test has
  `STATIC_ORIGIN` set to it. It serves the files the upload would send, with
  the headers the upload stores, byte ranges, and the
  `Access-Control-Allow-Origin` header the hostname rule adds. So the tests
  show that pages load every built file from the static origin and still
  work, and that the upload's files and headers are right. They can't show
  what only Cloudflare does: that R2 and its cache send those headers and
  byte ranges, and that nothing on the hostname adds a cookie.
  [self-hosting.md](self-hosting.md#the-static-host) has the check for a
  real deployment.
- **Every cookie the tests see is checked** by `apps/web/e2e/fixtures.ts`.
  Every spec takes `test` from it, which a lint rule enforces. It reads each
  `Set-Cookie` header on every response in every browser context and from
  the `request` fixture, and the cookie jar of each context still open when
  a test ends, which catches a cookie set from a script. A cookie from the
  site that is not host-only, `Secure`, and `Path=/` with the `__Host-`
  prefix fails the test, and so does any cookie from the static host.
  Other origins, like the GitHub fake, are not checked. The site sets no
  cookies yet, so a test checks that the fixture sees the responses of
  pages and requests from both hosts.
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
- **The GitHub fake's own tests** run with Vitest in Node, in
  `packages/github-fake/test/`.
- **The tests for `scripts/`** cover the static server, the skill build, the
  deploy, and the check for advisories a pull request adds. They use Node's
  own test runner. The deploy's tests fake Cloudflare's API, GitHub's OIDC
  endpoint, and Wrangler, and check the scripts, the deploy workflows, and
  [self-hosting.md](self-hosting.md) against each other.

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

### Security scans

`.github/workflows/security.yml` runs on every pull request under the same
rules as CI. Each tool a job downloads itself is checked against a published
checksum that the workflow pins, and the Semgrep image is pinned by digest.
The CodeQL action brings the CodeQL version its commit names. Semgrep's rules
come from the Semgrep Registry at scan time, since their license doesn't allow
copying them here. A job names a finding only when it sits in code the pull
request adds or edits, which the diff already shows. Findings elsewhere on
`main` stay in code scanning.

| Job | What it scans | What it blocks | Where findings go |
|---|---|---|---|
| `semgrep` | Code and workflows, with Semgrep's TypeScript, React, and GitHub Actions rules | A high-severity finding the pull request adds or edits | Code scanning |
| `codeql` | JavaScript and TypeScript, with CodeQL's default queries | An alert at `error` level, or of high or critical security severity, on a line the pull request changes, through the `Code scanning results / CodeQL` check | Code scanning |
| `zizmor` | Every workflow and action | A high-severity finding in any of them | Code scanning |
| `osv-scanner` | `pnpm-lock.yaml` before and after the pull request, against osv.dev | A package version with a high or critical advisory, or a known-malicious package, that the pull request adds | The job log, naming only what the pull request adds |
| `dependency-review` | The dependency graph before and after the pull request, against the GitHub Advisory Database | A package version with a high or critical advisory that the pull request adds | The job log and summary, naming only what the pull request adds |

Each tool uploads under one fixed category, the same on pull requests and on
`main`: `semgrep`, `/language:javascript-typescript` for CodeQL, and
`zizmor`. OSV-Scanner uploads as `osv-scanner`, from `main` only.

Code scanning accepts uploads from a pull request's read-only token, from a
fork too. On the pull request it shows a finding as an annotation only when
the finding sits on a line the pull request changes. The rest stays in the
Security and quality tab, which only people with write access can see. The
`semgrep` and `zizmor` jobs fail with a short message that points there.
Every job but `zizmor` fails only on what the pull request adds or edits.
zizmor's check runs offline with a pinned version, so a high finding in any
workflow can only come from a workflow change, and it blocks every pull
request until it is fixed.

The pull request jobs get `contents: read` and no `security-events` access.
So the CodeQL action warns that it can't read its feature flags, and a job
can't check whether GitHub processed the SARIF it uploaded. If GitHub can't
process a pull request's SARIF, the job still passes. The same SARIF fails
the upload on `main`, where the job can check, and the ruleset keeps waiting
for pull request results that never arrive.

OSV-Scanner's SARIF carries no line numbers, which GitHub's SARIF reference
lists as required. Nothing documented keeps code scanning from annotating an
advisory already on `main` on a pull request that touches the lockfile, so
pull requests don't upload it. Expect a warning on each pull request's code
scanning results that one configuration on `main`, `osv-scanner`, was not
found. The `osv-scanner` job is the lockfile's gate.

A pull request can switch off its own checks with a `nosemgrep` comment, a
`.semgrepignore` file, a zizmor ignore comment or config file, or an edit to
`scripts/new-advisories.mjs` or these workflows, since each job runs from the
pull request's checkout. Reviewers watch for changes to any of them.

`.github/workflows/security-main.yml` runs Semgrep, CodeQL, zizmor, and
OSV-Scanner on `main` on every push, every Monday at 05:23 UTC, and by hand
from the Actions tab. The push runs give each pull request a fresh analysis
of its base to compare with, and close an alert soon after its fix merges.
The Monday run catches new advisories and new rules for code that hasn't
changed. It uploads every finding to code scanning. Its jobs fail when a scan
or an upload breaks, and findings leave them green. It is the only scan
workflow that can write, and it writes only `security-events`, which the
upload needs.

Code scanning matches each finding to the alert it already has, so a second
run files nothing new. Matching can slip in three ways. OSV-Scanner's
fingerprint holds the lockfile's absolute path on the runner and the package
version, so a new path, or a bump to another vulnerable version, files a new
alert. A Semgrep rule that gets a new ID files a new alert. And when the
content of a flagged line changes, code scanning can file its finding again.

Dependabot alerts tell maintainers about new dependency advisories. Code
scanning tells no one, so a maintainer checks the Security and quality tab
each week. [SECURITY.md](../SECURITY.md) says what happens next.

Two habits keep findings out of public logs. SARIF files are never kept as
workflow artifacts, which anyone signed in can download. And a CodeQL job is
never re-run with debug logging, because CodeQL then keeps its results as an
artifact.

#### Turning the scans on

A required tool that has never uploaded blocks every merge. So the first
time, a maintainer goes in this order:

1. Turn CodeQL default setup off before the pull request that adds these
   workflows runs its checks. Code scanning refuses CodeQL results from a
   workflow while default setup is on.
2. Merge that pull request.
3. Run "Security on main" by hand from the Actions tab.
4. Check that all four categories above show up under code scanning in the
   Security and quality tab.
5. Only then add the required checks and the code scanning ruleset.

After that, these settings stay on: private vulnerability reporting,
Dependabot alerts, branch protection that requires the five security jobs above, and a
ruleset that requires code scanning results. In the ruleset, CodeQL gets
"Security alerts: High or higher" and "Alerts: Errors". Semgrep OSS and zizmor
get "Alerts: Errors", since their SARIF carries no security severity. CodeQL
default setup and Dependabot security updates stay off.

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
   is a domain. It refuses a `GH_API_URL` or `GH_WEB_URL` that isn't an
   `https` URL, and leaves each empty when its setting is, so the Worker
   calls GitHub itself. It checks `STATIC_ORIGIN`, which has to be an
   `https` origin on a hostname the site doesn't use, though the config
   doesn't hold it. It masks the account ID, resource names and IDs, the
   static origin, and the value of every variable but `ENVIRONMENT` for the
   later steps, Wrangler's output included. A key or binding it does not
   know stops the deploy, so a new kind of binding never reaches Cloudflare
   with its local name.
3. The Vite build reads that file through
   `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`, and `STATIC_ORIGIN` from the
   setting, and writes the config Wrangler deploys from.
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
8. `deploy.mjs static-assets` uploads the built files the static host
   doesn't have yet, as [The static host](#the-static-host) describes. It
   does nothing when `STATIC_ORIGIN` is empty.
9. `wrangler deploy`. On the first deploy, Wrangler creates the KV namespace
   when `OAUTH_KV_ID` is empty, and reuses it after that.
10. `deploy.mjs smoke-test` reads `/healthz` on the primary domain, or the
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
- **A GitHub fake with state, built from GitHub's docs.** Recorded
  responses can't follow a fork into a commit into a PR, and recording them
  would need real accounts. The fake keeps state, so a flow behaves the
  same in a test as on GitHub, and it records whose token made each call,
  which is how the tests check that no action runs as the wrong person.
- **The fake is its own package** so the Worker's tests, the Playwright
  tests, and later packages share one fake and one set of sample data,
  while the Worker never depends on it. It runs in both `workerd` and Node,
  and Node runs its server straight from the TypeScript source.
- **graphql-js runs the fake's GraphQL.** A slice of GitHub's schema, with
  GitHub's names and types, means aliases, fragments, variables, and
  validation errors behave as they do on GitHub.
- **Code scanning holds security findings.** Alerts on `main` are visible
  only to people with write access, code scanning matches repeat findings by
  fingerprint, and a workflow can file into it. Issues and pull request
  comments are public.
- **Semgrep and CodeQL both.** CodeQL follows data across functions and
  files, such as a token that reaches a log. Semgrep's free rules match
  patterns within a file, cover GitHub Actions, and run in seconds.
- **Dependabot alerts on, security updates off.** Dependabot alerts are
  private too, and GitHub tells maintainers when one is filed, which code
  scanning never does. A dependency advisory can then show up in both places.
  A security update pull request is public and names its advisory before a
  maintainer has looked at it.
- **No OpenSSF Scorecard.** Its workflow checks repeat zizmor's, and its other
  checks grade practices this repo doesn't have yet, such as fuzzing and
  signed releases, so it would file alerts nobody fixes.
