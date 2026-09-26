# Architecture

How the pieces fit today, and why the big choices were made. The plan for the
rest is in [specs/v1.md](specs/v1.md). This file changes in the same pull
request as the code it describes.

## The pieces

The repo is a pnpm workspace.

| Path | What it is |
|---|---|
| `apps/web` | One Cloudflare Worker for the whole service. Today it serves a placeholder home page and `/healthz`. The site, the MCP server, queue consumers, and scheduled jobs all join it here. |
| `packages/core` | Shared schemas and types: project settings, the claim state machine, the input, output, and text of every MCP tool, feed events, and refusal codes. Other packages import its TypeScript source directly, with no build step. |
| `scripts/` | The static server behind `pnpm prototype`, and the deploy scripts, with their tests. |
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
- **The core package's tests** run with plain Vitest in Node, since the
  package is pure. They live in `packages/core/test/`.
- **The tests in `scripts/`,** for the static server and the deploy, use
  Node's own test runner. The deploy's tests fake Cloudflare's API, GitHub's
  OIDC endpoint, and Wrangler, and check the scripts, the deploy workflows,
  and [self-hosting.md](self-hosting.md) against each other.

`pnpm test` runs all of them but Playwright. `pnpm test:e2e` runs Playwright.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to
`main`, on GitHub-hosted runners, with a read-only token. It uses no secrets,
so a pull request from a fork runs the same checks as one from a branch.
Every action is pinned to a commit SHA.

| Job | What it runs |
|---|---|
| `test` | `pnpm test` |
| `lint` | `pnpm lint`: ESLint with type-aware rules from typescript-eslint |
| `typecheck` | `pnpm typecheck` |
| `e2e` | `pnpm test:e2e` in Chromium, keeping the report and traces when it fails |
| `leaks` | gitleaks over the full history, with the rules in `.gitleaks.toml` |
| `actionlint` | actionlint over every workflow, with shellcheck on their `run:` scripts |

Branch protection requires `test` and `leaks` by name.

## Deploys

`.github/workflows/deploy.yml` runs on every push to `main`, and by hand. It
calls `deploy-environment.yml` for staging, and then for production when the
`DEPLOY_PRODUCTION` repository variable is `true`. Each call is one job in the
GitHub environment it deploys, and reads every deployment value from there.
[self-hosting.md](self-hosting.md) lists the settings and the one-time setup.

The job runs these steps. The scripts are in `scripts/`.

1. `deploy-config.mjs` reads `wrangler.jsonc` and writes
   `apps/web/wrangler.deploy.json`, which git ignores. It names the Worker
   `WORKER_NAME` and every other resource `<WORKER_NAME>-<local name>`. It
   copies in each ID that is set and leaves out each one that isn't. It sets
   every variable from the setting of the same name, so no local value
   reaches a deployed Worker, and sets `ENVIRONMENT` to the target. It
   attaches `PRIMARY_DOMAIN` and `REDIRECT_DOMAINS` as custom domains and
   turns workers.dev off when there is a domain. A key or binding it does not
   know stops the deploy, so a new kind of binding never reaches Cloudflare
   with its local name.
2. The Vite build reads that file through
   `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`, and writes the config Wrangler
   deploys from.
3. `deploy.mjs credential` puts a Cloudflare token in `$GITHUB_ENV` for the
   later steps: the `CLOUDFLARE_API_TOKEN` secret, or a short-lived token from
   the credential broker, traded for the job's GitHub OIDC token.
4. `deploy.mjs resources` creates each D1 database that has no ID, and each
   queue, dead-letter queues included, when missing. Wrangler would create a
   missing producer queue itself, but not a dead-letter queue, and a database
   has to exist before its migrations run.
5. `deploy.mjs migrations` runs `wrangler d1 migrations apply --remote` for
   each database that has a migrations folder, and skips one that has none.
6. `deploy.mjs secrets` puts each secret in `secrets.required` with
   `wrangler secret put`, one at a time, from the environment secret of the
   same name. The value reaches Wrangler on stdin only.
7. `wrangler deploy`. On the first deploy, Wrangler creates the KV namespace
   when `OAUTH_KV_ID` is empty, and reuses it after that.
8. `deploy.mjs smoke-test` reads `/healthz` on the primary domain, or the
   workers.dev URL Wrangler reported, until it answers ok from the target
   environment. It fails at once if another environment answers, and after
   three minutes otherwise.

Choices:

- **One setting names every resource.** New bindings get deployed names
  without new settings. Only IDs, which Cloudflare assigns, need one each.
- **Each setting can be a variable or a secret.** The logs of a public repo
  are public, and GitHub prints a variable in the log of the step that reads
  it. So the config step reads each setting as `secrets.NAME || vars.NAME`,
  and masks the account ID, resource names and IDs, and domains for every
  later step, Wrangler's output included.
- **One reusable workflow runs both environments,** so staging and production
  always run the same steps.
- **The build runs before the job holds a Cloudflare token,** so build code
  never sees it.
- **Deploys run one at a time** and are never cancelled midway. Deploy jobs
  have `id-token: write` for the broker and read-only contents.

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
