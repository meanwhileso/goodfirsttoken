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
| `packages/github-fake` | A fake GitHub for tests and local development, and the sample people and repos. It records whose token made each call. Only tests and dev tooling import it. |
| `scripts/` | The static server behind `pnpm prototype`, with its tests. |
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
- **`src/github.ts` makes every call to GitHub,** REST and GraphQL, at the
  base URLs in `GITHUB_API_URL`. Each call takes the token it runs with as
  an argument. There is no default token.

## Bindings

`apps/web/wrangler.jsonc` is the config for local development. It declares
every binding the Worker reads, under local names. Staging and production are
not in the repo. The deploy workflow (#32) will write their config from the
GitHub environment's variables, including the resource names and IDs.

| Binding | Kind | Used from |
|---|---|---|
| `ENVIRONMENT` | Variable: `development`, `staging`, or `production` | Now, by `/healthz` |
| `GITHUB_API_URL` | Variable: GitHub's REST and GraphQL API. `https://api.github.com` when deployed, the GitHub fake locally | Now, by `src/github.ts` |
| `GITHUB_WEB_URL` | Variable: github.com itself, for OAuth sign-in. `https://github.com` when deployed, the GitHub fake locally | #8 |
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
`apps/web/.wrangler/`. It also starts the GitHub fake at
`http://127.0.0.1:8944`, which `wrangler.jsonc` points the Worker at. The
variables the app reads, with safe local defaults, are listed in
`apps/web/.dev.vars.example`.

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
  timeline, and merging it closes the issues it says it closes. Search
  serves at most 1,000 results. API calls need a User-Agent.
- **Where it differs.** A search qualifier it doesn't know gets a 422
  naming the file to add it to, where GitHub would read it as text. It
  treats a `localhost` OAuth callback like GitHub's `127.0.0.1` loopback
  rule, so any port works. Git object IDs are 40 hex characters from a fast
  hash, not Git's SHA-1. It cannot be cloned with `git`.
- **Nothing in it touches the network.** In a test, `fake.fetch` stands in
  for the global `fetch` and throws for any URL outside the fake's two base
  URLs, which default to hosts under `.test`, a domain that never resolves.
  Every URL in its responses, including avatars and raw files, points back
  at the fake.
- **The sample data** in `src/sample-data.ts` is the prototype's people,
  projects, issues, and PRs, and the one place later issues add to. It is
  made up, and says nothing about the real projects that share a name.
- **Local sign-in.** The fake's authorize page lists the sample people. Pick
  one, and the app gets that person's token through the same OAuth flow it
  uses with GitHub.
- **Local state.** The server `pnpm dev` starts keeps its state in
  `apps/web/.wrangler/github-fake/state.json`, next to Miniflare's, so forks
  and commits survive a restart. `pnpm seed` resets it to the sample data.
  The Playwright server starts fresh every time.
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
- **The GitHub fake's own tests** run with Vitest in Node, in
  `packages/github-fake/test/`.
- **The static server's tests** in `scripts/` use Node's own test runner.

`pnpm test` runs all but Playwright. `pnpm test:e2e` runs Playwright.

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
