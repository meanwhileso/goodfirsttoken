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
| `scripts/` | The static server behind `pnpm prototype`, and the check for advisories a pull request adds, with their tests. |
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
- **The static server's tests** in `scripts/` use Node's own test runner.

`pnpm test` runs the first and last. `pnpm test:e2e` runs Playwright.

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

### Security scans

`.github/workflows/security.yml` runs on every pull request under the same
rules as CI. Each tool a job downloads itself is checked against a published
checksum, and the Semgrep image is pinned by digest. The CodeQL action brings
the CodeQL version its commit names. Semgrep's rules come from the Semgrep
Registry at scan time, since their license doesn't allow copying them here. A
job names a finding only when it sits in code the pull request adds or edits,
which the diff already shows. Findings elsewhere on `main` stay in code
scanning.

| Job | What it scans | What it blocks | Where findings go |
|---|---|---|---|
| `semgrep` | Code and workflows, with Semgrep's TypeScript, React, and GitHub Actions rules | A high-severity finding the pull request adds | Code scanning |
| `codeql` | JavaScript and TypeScript, with CodeQL's default queries | A high or critical alert on a line the pull request changes, through the `Code scanning results / CodeQL` check | Code scanning |
| `zizmor` | Every workflow and action | A high-severity finding in any of them | Code scanning |
| `osv-scanner` | `pnpm-lock.yaml` before and after the pull request, against osv.dev | A package version with a high or critical advisory, or a known-malicious package, that the pull request adds | The job log, naming only what the pull request adds |
| `dependency-review` | The dependency graph before and after the pull request, against the GitHub Advisory Database | A package version with a high or critical advisory that the pull request adds | The job log and summary, naming only what the pull request adds |

Code scanning accepts uploads from a pull request's read-only token, from a
fork too. On the pull request it shows a finding as an annotation only when
the finding sits on a line the pull request changes. The rest stays in the
Security and quality tab, which only people with write access can see. The
`semgrep` and `zizmor` jobs fail with a short message that points there.
Every job but `zizmor` fails only on what the pull request adds or edits.
zizmor's check runs offline with a pinned version, so a high finding in any
workflow can only come from a workflow change, and it blocks every pull
request until it is fixed.

`.github/workflows/security-weekly.yml` runs Semgrep, CodeQL, zizmor, and
OSV-Scanner on `main` every Monday at 05:23 UTC, and by hand from the Actions
tab. It catches new advisories and new rules for code that hasn't changed. It
uploads every finding to code scanning, and fails only when a scan or an
upload breaks. It is the only workflow that can write, and it writes only
`security-events`, which the upload needs. Code scanning matches each finding
to the alert it already has, so a second run files nothing new. Code scanning
doesn't notify anyone when it files an alert, so a maintainer checks the
Security and quality tab after the Monday run. [SECURITY.md](../SECURITY.md)
says what happens next.

Two habits keep findings out of public logs. SARIF files are never kept as
workflow artifacts, which anyone signed in can download. And a CodeQL job is
never re-run with debug logging, because CodeQL then keeps its results as an
artifact.

The scans rely on these repository settings:

- Private vulnerability reporting is on.
- CodeQL default setup is off, since code scanning refuses CodeQL results
  from a workflow while it is on.
- Dependabot alerts are off, since OSV-Scanner files the same advisories.
- Branch protection requires the five jobs above, and a ruleset requires code
  scanning results from CodeQL, Semgrep OSS, and zizmor at high severity.

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
- **Code scanning holds security findings.** Alerts on `main` are visible
  only to people with write access, and code scanning matches repeat
  findings by fingerprint. Dependabot alerts are private too, but a workflow
  can't file them, and they would repeat every OSV-Scanner alert. Issues and
  pull request comments are public.
- **Semgrep and CodeQL both.** CodeQL follows data across functions and
  files, such as a token that reaches a log. Semgrep's free rules match
  patterns within a file, cover GitHub Actions, and run in seconds.
- **No Dependabot security updates or OpenSSF Scorecard.** Security updates
  need Dependabot alerts, which would file every advisory a second time, and
  they open a pull request for each one. Scorecard's workflow checks repeat
  zizmor's, and its other checks grade practices this repo doesn't have yet,
  such as fuzzing and signed releases, so it would file alerts nobody fixes.
