# Architecture

How the pieces fit today, and why the big choices were made. The plan for the
rest is in [specs/v1.md](specs/v1.md). This file changes in the same pull
request as the code it describes.

## The pieces

The repo is a pnpm workspace.

| Path | What it is |
|---|---|
| `apps/web` | One Cloudflare Worker for the whole service. Today it serves a placeholder home page, the design system at `/design`, and `/healthz`, and holds the D1 schema and the functions that read and write it. The site, the MCP server, queue consumers, and scheduled jobs all join it here. |
| `packages/core` | Shared schemas and types: project settings, the claim state machine, every record the database stores, the input, output, and text of every MCP tool, feed events, and refusal codes. Other packages import its TypeScript source directly, with no build step. |
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
- **Data access lives in `src/db/`,** one module per table, described under
  [Database](#database). The migrations that make the tables are in
  `migrations/`.
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
  rest are built from: GitHub logins and numeric IDs, repos, issues, labels,
  and PRs, and our IDs, times, and links. `projects.ts` holds projects, their
  settings, and each saved version of the settings, `claims.ts` the claim
  state machine and the stored claim, `prs.ts` a claim's PR, `issues.ts` a
  cached tagged issue, `people.ts` people, their interests, and blocks,
  `sessions.ts` donor sessions and budgets, `crawl.ts` crawl candidates and
  the do-not-list, `feed.ts` feed events, `refusals.ts` the refusal codes, and
  `validation.ts` the check that names the field in every problem.
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
| `DB` | D1 | `src/db/`, from #8 on |
| `OAUTH_KV` | KV, for OAuth grants | #9 |
| `FEED_QUEUE` | Queue producer | #14 |
| `CRAWL_QUEUE` | Queue producer | #30 |

The feed's dead-letter queue arrives with the feed consumer in #14. Durable
Objects, cron triggers, and rate limiters arrive with the issues that use
them. The static host's R2 bucket is not a binding, since the Worker never
reads it. [The static host](#the-static-host) covers it.

## Database

D1, bound as `DB`, holds the structured records that search and the
leaderboard read: people, projects with their settings and status changes,
the tagged-issue cache, claims, PRs, donor sessions, blocks, the
do-not-list, and crawl candidates. GitHub is the source of truth for issues
and PRs, and the issue room (#13) will be for claims, so those tables are
caches and mirrors. Better Auth's own tables arrive with #8. No table holds a
GitHub token. Tokens stay in the encrypted grant store. The rules these
records follow are in [how-it-works.md](how-it-works.md#people), under
People through Crawl candidates.

| Table | One row per | Key |
|---|---|---|
| `people` | Person who has signed in: login, interests, when they joined, and when GitHub last showed their login | `github_id` |
| `projects` | Project: its current status, reason, and who set it and when, how it got in, with the policy quote, link, and tier for a policy listing, who added it and when, where its issues live, and its current settings version | `repo` |
| `project_settings` | Save of a project's settings: the whole settings, who saved them, and when | `repo`, `version` |
| `project_status_changes` | Change of a project's status: the status, the reason, who made it, and when | `id` |
| `tagged_issues` | Project's copy of an open tagged issue, as the last sync read it: title, labels, linked open PR, and sync time | `project`, `issue_repo`, `number` |
| `claims` | Claim, mirrored from its issue room: issue, project, claimant, login when they claimed, agent, own-project flag, start commit, token estimate, state, times, release reason, PR, and the room's revision | `id` |
| `prs` | PR opened for a claim: repo, number, link, state, and when it opened, merged, and closed | `claim_id` |
| `donor_sessions` | Donor session: harness, budget, start time, and issues claimed | `id` |
| `donor_blocks` | Blocked donor: reason, admin, and time | `github_id` |
| `do_not_list` | Repo whose maintainers asked to be removed: note, admin, and time | `repo` |
| `crawl_candidates` | Crawler find: repo facts, policy, suggested settings and tags, status, and the admin's decision | `id` |

Each module in `apps/web/src/db/` owns one table, and `projects.ts` owns the
three project tables. Its functions take the database first, so the Worker
passes `env.DB` and a test passes its own. Every function checks what it
writes with the core schema before the write, and checks every row it reads
with the same schema, so a bad value never reaches the database and a bad
row never reaches the caller. Either throws a `TypeError` that names the
field. `changeSettings` is the one exception. A maintainer can fix settings
that break the rules, so it returns the problems for the caller to show.

### Storage choices

- **Times are INTEGER milliseconds since the epoch.** The claim state
  machine and Durable Object alarms use that unit, so the issue room can
  mirror a claim without converting it. Integers compare and sort as they
  are, which a week's range on the leaderboard needs, and SQLite has no time
  type. ISO 8601 stays the form on the wire, in tool results and feed events.
- **Lists and small objects are JSON text:** settings, interests, labels,
  budgets, suggested settings, and suggested tags. A PR is three columns,
  repo, number, and link, so it can be found by number. So is a policy.
- **Every repo and login column uses `COLLATE NOCASE`,** which gives the
  case rules in how-it-works.md. An index on such a column compares the same
  way.
- **Tables are STRICT,** so SQLite refuses a value of the wrong type.
- **No CHECK constraints.** The rules live in the core schemas, which every
  read and write goes through. SQLite can only change a CHECK by rebuilding
  the table, so a rule kept there would turn each rule change into a rebuild.
- **Foreign keys** tie every row that names a person to `people`, settings,
  status changes, and cached issues to their project, and a PR to its claim.
  D1 enforces them. A claim's project has none, so a claim's history can
  outlive a listing.
- **IDs** for sessions and candidates are made in `src/db/`: a prefix and 20
  URL-safe characters, the base64url form of 15 random bytes, like
  `s_2x8Qm0vT4kLp9aZr1yWc`. The issue room makes claim IDs.
- **`claims.login` is the login when the claim was made.** The current login
  is in `people`, found by GitHub ID. A page should show that one, because a
  renamed login can later belong to someone else.
- **`tagged_issues` has no assignee.** An issue with an assignee isn't
  eligible, and the sync (#12) leaves it out, so no cached issue has one. The
  server checks GitHub again before it suggests or claims an issue, which
  catches an assignee added since the last sync.

### Who sees what

The spec says everything the site shows is public GitHub data or the public
live feed. It says crawl results stay in the deployment's database, and only
listed projects and their policy quotes are public, so `crawl_candidates`
stays private, a rejection's reason included. The reason an admin gives for
rejecting a registration reaches the maintainer's agent.

These columns are not public GitHub data, and the spec says nothing more
about who sees them: `people.interests`, `donor_sessions.budget`,
`donor_blocks.reason`, and `do_not_list.reason`.

### Settings history

A project's row points at its current row in `project_settings` with
`settings_version`. Every save adds a row holding the whole settings, who
saved them by GitHub ID, and when, and no row is ever overwritten. What a
save changed is worked out by comparing it with the save before, using
`changedSettings` from core, so the history can't disagree with the
settings.

A save reads the current version, applies the change with core's
`updateProjectSettings`, and writes the next version in one batch. Both
statements in the batch check that the version is still the one read, and
D1 runs a batch as one transaction. When another save landed first, neither
statement applies, and the save reads again and reapplies its change, up to
five times. That is how two changes at once both land, as
[Project settings](how-it-works.md#project-settings) says.

### Status changes

A project's row holds its current status and reason, who set them, and
when, so the lists by status read one table. `project_status_changes` keeps
every change, and adding the project writes the first. `setProjectStatus`
writes both in one batch, and each statement applies only when the status or
reason differs from the stored one.

### The claims mirror

`saveClaim` takes the claim and the room's revision of it. The fields fixed
when a claim is made, listed under
[the claims table](how-it-works.md#claims), are compared in the same
statement as the write, and so are the revision and the claim's PR.

What the issue room (#13) does: number each version of a claim you save,
and give every change a higher number than the last. A counter kept with the
claim in the room's storage does it. Save each change with its number, and
save again with the same number when a save may not have landed. What a
stale save does is under [the claims table](how-it-works.md#claims).

`claims` keeps the claim's PR as the room records it, and `prs` keeps what
GitHub says about that PR afterwards. Either can name the PR first, so for a
while one names it and the other names none. `saveClaim` refuses a claim
that names a PR other than the one in `prs`, and `addPr` refuses a PR other
than the one the claim names. So the two never name two different PRs for
one claim. Each checks the other table in the same statement as its write,
so neither can land between the other's check and write.

### Indexes

Each index serves a query that a page, a tool, a job, or the leaderboard
needs. The leaderboard isn't built yet, and #26 writes its queries. The
plans below were checked with `EXPLAIN QUERY PLAN`. The key of
`tagged_issues` leads with the project, so it serves a project's issues,
suggestions across approved projects through `projects_by_status`, and
pruning after a sync, with no index of its own.

| Index | Serves |
|---|---|
| `people_by_login` | A person by login, for `/@<login>` pages and admin blocks |
| `projects_by_status` | The list of approved projects and the admin queue of pending ones, oldest first |
| `projects_by_issue_repo` | The projects whose issues live in a repo, for a claim or a sync |
| `project_status_changes_by_repo` | A project's status changes, newest first |
| `claims_by_issue` | An issue's lanes, its slots, how many times it was claimed, and the tough badge |
| `claims_by_person` | One person's claims, newest first: `my_work`, their page, and their leaderboard row |
| `claims_by_project` | One project's claims in a time range: its page and its row on the leaderboard by project |
| `prs_by_number` | A PR's claim, and one claim per PR |
| `prs_open` | The open PRs the PR job follows, oldest first |
| `prs_by_opened` | PRs opened in a time range, like this week |
| `prs_by_closed` | PRs merged or closed in a time range, like this week |
| `donor_sessions_by_person` | A donor's last session, for what merged since |
| `crawl_candidates_waiting` | One waiting candidate per repo |
| `crawl_candidates_by_status` | The admin queue's crawler finds, oldest first |

A merged PR always has a close time, as on GitHub, and only `closed_at` is
indexed. So merged PRs this week filter on `closed_at` with
`state = 'merged'`, which reads `prs_by_closed`. Filtering on `merged_at`
uses no index, so it reads every PR or every claim, depending on the query.
Merge rate reads the same index.

Some views have no index of their own. Issues worked per person this week
scans every claim. The all-time views scan `claims` or `prs` and look up the
other by key, and hiding blocked donors looks up `donor_blocks` by key.

### Migrations

Migrations live in `apps/web/migrations/`, Wrangler's default folder,
numbered in order. `pnpm dev` runs `apps/web/scripts/migrate-local.mjs`
before it starts Vite. The script runs `wrangler d1 migrations apply DB
--local` with no input attached. Wrangler asks before it applies a migration
only when both its input and output are a terminal, so it applies new ones
without asking, whether `pnpm dev` runs from the root, where pnpm runs the
GitHub fake beside it, or in `apps/web`. It needs no network and no account.
The database tests apply the migrations in their setup, and a deploy applies
them to the environment's database before the Worker goes up, as
[Deploys](#deploys) describes. A schema change is a new migration. A
migration that has run on a deployed database never changes.

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

Local development needs none of it. `pnpm dev` applies the D1 migrations to
the local database, then runs the Worker in Miniflare, which simulates every
binding and keeps D1 and KV data on disk under `apps/web/.wrangler/`. It
also starts the GitHub fake at `http://127.0.0.1:8944`, which
`wrangler.jsonc` points the Worker at. The variables the app reads, with
safe local defaults, are listed in `apps/web/.dev.vars.example`.

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
  adds each file directly in `src/assets/` to the build, hidden ones aside.
  It doesn't look in folders under it. A page that imports one with `?url`
  gets the same file. The Worker's static assets hold the same files, so
  emptying `STATIC_ORIGIN` again needs nothing else.
- **The upload.** `scripts/deploy.mjs static-assets` runs right after the
  credential step, with Cloudflare's API. It checks that the bucket,
  `<WORKER_NAME>-static`, exists. Then it asks R2 for every file by its
  path before it uploads any. A file R2 has is downloaded and compared byte
  for byte. The object endpoint it uses, the one Wrangler uses, is not in
  Cloudflare's API reference, so the ETag it may send is not relied on. The
  files R2 doesn't have go up with their content type and
  `Cache-Control: public, max-age=31536000, immutable`, which R2 sends back
  with the file. `scripts/static-host.mjs` lists the files and their
  headers for the upload and for the tests' stand-in alike. A file keeps
  the headers it first went up with, so a file whose type
  `scripts/serve.mjs` doesn't know stops the upload before anything goes
  up. The upload never creates the bucket, whose custom domain is attached
  by hand.
- **The check.** The same step then fetches one file of each kind from
  `STATIC_ORIGIN`, as a browser would, without following a redirect. It
  looks at the answer's status, its `Content-Type` and `Cache-Control`,
  which have to match what the upload stored, its
  `Access-Control-Allow-Origin`, and any `Set-Cookie`. It doesn't read the
  body, since the upload already compared the bytes in the bucket.
  [how-it-works.md](how-it-works.md#static-assets) has the rule it
  enforces. Byte ranges are left to the check by hand in
  [self-hosting.md](self-hosting.md#the-static-host). How Cloudflare's
  cache answers a range for a file it doesn't hold yet couldn't be
  confirmed while building this, and a wrong guess would block deploys.
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
  HTTP tests call the whole Worker through `exports.default.fetch` from
  `cloudflare:workers`, so a test sees the same routing and headers a
  browser does. Code no route uses yet, like `src/github.ts`, is called
  directly. They live in `apps/web/test/`. A test that calls GitHub creates
  the GitHub fake in-process and puts `fake.fetch` in place of the global
  `fetch`. `vitest.config.ts` points GitHub's URLs at hosts under `.test`.
- **Database tests** call the functions in `src/db/` against a real local
  D1. The Vitest config reads `migrations/`, and a setup file applies them
  before each test file. Each test file gets its own storage, and the tests
  in a file share it, so each database test starts by emptying every table.
  They live in `apps/web/test/db/`.
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
  byte ranges, that nothing on the hostname adds a cookie, and that no
  cookie Cloudflare sets for the whole zone reaches it. Each deploy checks
  the headers and the static host's own cookies against the real static
  host. [self-hosting.md](self-hosting.md#the-static-host) covers the rest.
- **Every cookie the tests see is checked** by `apps/web/e2e/fixtures.ts`.
  Every spec takes `test` from it, which a lint rule enforces for every
  extension Playwright runs, and for `@playwright/test` and
  `playwright/test` alike, by name, as the default, or by `require` or
  `import()`. It reads each
  `Set-Cookie` header on every response in every browser context and from
  the `request` fixture. When a test ends, it also reads the cookie jar of
  the `request` fixture and of each browser context still open, which
  catches a cookie set from a script or on a redirect the `request` fixture
  followed. A cookie from the site that is not host-only, `Secure`, and
  `Path=/` with the `__Host-` prefix fails the test, and so does any cookie
  from the static host. So does a response from either whose headers can't
  be read, unless the test closed its context first. Other origins, like
  the GitHub fake, are not checked. The site sets no cookies yet, so
  `cookies.spec.ts` checks that the fixture sees the responses of pages and
  requests from both hosts. It also runs two servers of its own that answer
  with bad cookies, one of them on a redirect the `request` fixture
  follows. It has the fixture take them as the site and the static host,
  and expects the fixture to report each cookie. Chromium doesn't report
  the `Set-Cookie` of an answer a route makes up, so those answers have to
  come over the network. The two fixture options it sets for this,
  `cookieHosts` and `expectedCookieProblems`, would let a bad cookie pass
  anywhere else, so a lint rule allows them only in `cookies.spec.ts`.
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
5. `deploy.mjs static-assets` uploads the built files the static host
   doesn't have yet, then checks the static host, as
   [The static host](#the-static-host) describes. It does nothing when
   `STATIC_ORIGIN` is empty. It comes before every step that changes the
   environment, since `wrangler secret put` makes a new version of the
   Worker live.
6. `deploy.mjs resources` creates each D1 database that has no ID, and each
   queue, dead-letter queues included, when missing. Wrangler would create a
   missing producer queue itself, but not a dead-letter queue, and a database
   has to exist before its migrations run.
7. `deploy.mjs migrations` runs `wrangler d1 migrations apply --remote` for
   each database that has a migrations folder, and skips one that has none.
8. `deploy.mjs secrets` puts each secret in `secrets.required` with
   `wrangler secret put`, one at a time, from the environment secret of the
   same name. The value reaches Wrangler on stdin only.
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
