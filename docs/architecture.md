# Architecture

How the pieces fit today, and why the big choices were made. The plan for the
rest is in [specs/v1.md](specs/v1.md). This file changes in the same pull
request as the code it describes.

## The pieces

The repo is a pnpm workspace.

| Path | What it is |
|---|---|
| `apps/web` | One Cloudflare Worker for the whole service. Today it serves the homepage, the projects list, each project's page, each issue's page, sign-in with GitHub, the MCP server at `/mcp` with its sign-in for agents and the views MCP Apps hosts show, the admin pages at `/admin`, the design system at `/design`, `/healthz`, and the live text streams and sockets, and holds the D1 schema, the functions that read and write it, the issue room, the live feeds, the feed queue's consumer, the scheduled jobs that read GitHub, and the policy crawler with its queue's consumer. The rest of the site joins it here. |
| `packages/core` | Shared schemas and types: project settings, the claim state machine, every record the database stores, the input, output, and text of every MCP tool, feed events, refusal codes, and the check that strips keys and tokens from posted text. Other packages import its TypeScript source directly, with no build step. |
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
  redirect domain itself, with `src/redirect.ts`, and an agent's sign-in over
  its limit. It hands everything else to the MCP server's OAuth provider,
  which answers `/mcp` and the OAuth routes and passes the rest back, and
  ends an agent's connection when the agent revokes its grant at the token
  endpoint. Of the requests passed back, it sends every one under `/auth` to
  `src/auth/routes.ts`, every path shaped like a text stream to
  `src/feed/streams.ts`, which also takes a page's live socket there, and
  the form on `/oauth/authorize` to `src/mcp/authorize.ts`. It hands every
  other one to TanStack Start, setting the status a page names, as the page
  on `/oauth/authorize` and an issue page do. Its `queue` handler hands a
  batch from the crawl queue, `crawl` locally and `<WORKER_NAME>-crawl`
  deployed, to the crawler's consumer, and every other batch to the feed
  queue's consumer. Its `scheduled` handler runs the job for each cron
  trigger, from `src/sync/`. The Durable Object classes are exported from
  it.
- **Routes live in `src/routes/`,** one file per route. Page routes export a
  component. HTTP endpoints like `/healthz` use `server.handlers`. The
  TanStack Router plugin writes `src/routeTree.gen.ts` on every dev run and
  build. It is committed, so a type check works without a build first.
- **Bindings and variables come from `cloudflare:workers`,** imported as
  `env`, so any module can read them.
- **Data access lives in `src/db/`,** one module per table, described under
  [Database](#database). The migrations that make the tables are in
  `migrations/`.
- **Durable Objects live in `src/rooms/`.** `issue-room.ts` is the issue
  room, described under [The issue room](#the-issue-room), and `feed.ts` the
  live feed, under [The live feeds](#the-live-feeds). `watchers.ts` holds
  what both do for the people watching.
- **The feed queue and the text streams live in `src/feed/`,** also under
  [The live feeds](#the-live-feeds).
- **`src/github.ts` makes every call to GitHub's API,** REST and GraphQL, at
  the base URL in `GH_API_URL`, or `https://api.github.com` when that is
  empty. Each call takes the token it runs with as an argument. There is no
  default token. Revoking a token takes the OAuth app's client ID and secret
  in its place. Sign-in trades codes for tokens at github.com itself, in
  `src/auth/auth.ts`. `gitHubRead` and `gitHubQuery` also hand back what the
  `x-ratelimit` headers say is left of the token's budget, and a
  `GitHubError` carries it too.
- **The scheduled jobs live in `src/sync/`,** described under
  [The sync](#the-sync).
- **Sign-in lives in `src/auth/`,** described under [Sign-in](#sign-in).
- **The homepage is `src/routes/index.tsx`,** with what it reads in
  `src/home/`, described under [The homepage](#the-homepage).
- **The issue page is `src/routes/$owner.$repo.issues.$number.tsx`,** with
  what it reads in `src/issue/`, described under
  [The issue page](#the-issue-page).
- **The projects list is `src/routes/projects.tsx`, and a project's page
  `src/routes/$owner.$repo.index.tsx`,** with what they read in
  `src/project/`, described under [The project pages](#the-project-pages).
- **`src/dev/` is for local development only:** the sample work `pnpm seed`
  gives a local site, and a route that works an issue as a sample person,
  described under [Sample data](#sample-data-in-development).
- **The MCP server lives in `src/mcp/`,** described under
  [The MCP server](#the-mcp-server).
- **What registering a project reads from GitHub, and the proposal's rules,
  live in `src/projects/`,** described under
  [The maintainer's tools](#the-maintainers-tools), with the rules for who
  may change a project's status. The files a repo's docs are read from, in
  `docs.ts`, and the rules for what they say, in `rules.ts`, are shared
  with the policy crawler.
- **What the donor's tools check, read, and write on GitHub, and how they
  order suggestions, live in `src/donor/`,** described under
  [The donor's tools](#the-donors-tools).
- **The policy crawler lives in `src/crawl/`,** described under
  [The policy crawler](#the-policy-crawler).
- **The admin's actions and the admin pages live in `src/admin/`,**
  described under [The admin's tools and pages](#the-admins-tools-and-pages).

### Sign-in

The rules are in [how-it-works.md](how-it-works.md#signing-in).

| File | What it does |
|---|---|
| `src/auth/auth.ts` | Sets up Better Auth with its GitHub provider and D1 |
| `src/auth/routes.ts` | Answers every request under `/auth`: the allowed routes, the same-site check on forms, sign-out's revocation, the dev sign-in, and the routes an agent's sign-in and Disconnect use |
| `src/auth/rate-limit.ts` | The sign-in rate limit and the MCP server's token endpoint limit, each counted by client address |
| `src/auth/session.ts` | Reads who is signed in from a request, and makes them the caller a permission check takes, with the token from their sign-in |
| `src/auth/viewer.ts` | The server function the root route calls on every page load, for the nav, with whether the person is an admin |
| `src/auth/SiteNav.tsx` | The nav with the signed-in person in it |
| `src/auth/permissions.ts` | `requirePermission` and the named permissions |
| `src/auth/settings.ts` | Reads the settings sign-in needs, with the development stand-ins, and the admins' GitHub IDs |

- **Better Auth 1.7.6, pinned,** with its GitHub provider and
  `encryptOAuthTokens` on. It talks to D1 through its Kysely adapter, which
  has a D1 dialect. At its first request in each isolate, Better Auth checks
  that the tables have every column it expects. So one instance is kept per
  origin and settings.
- **A half-written sign-in.** D1 has no interactive transactions, so Better
  Auth writes a new user and their GitHub account one after the other, and a
  failure between them leaves a user with no account. Account linking is on
  for GitHub alone, as a trusted provider, with no need for a verified email.
  So the next sign-in finds that user by email and attaches the GitHub
  account. Each email is the placeholder made from the numeric GitHub ID, and
  GitHub is the one way in, so an email matches only the same GitHub account.
- **Replacing a token.** Better Auth writes each new token over the stored
  one. Our `getUserInfo` runs just before that write, so it looks up the
  person's GitHub account and revokes the stored token when the new one is
  different. Better Auth also calls `getUserInfo` with the stored token
  itself, for its account info, and that has to revoke nothing. It reads
  Better Auth's context from a small plugin that keeps it.
- **Sign-out** lists the person's sessions before it revokes anything, and
  ends only those. It forgets the token with one update through Better
  Auth's adapter that matches the account and the encrypted token it
  revoked. A sign-in in another browser meanwhile stores a token that
  doesn't match and a session that wasn't listed, so both stay.
- **GitHub's URLs come from `GH_WEB_URL` and `GH_API_URL`.** Better Auth's
  GitHub provider names github.com and api.github.com itself. The provider's
  options move the authorize page to `GH_WEB_URL`, reading the person goes
  through `src/github.ts`, and a small Better Auth plugin moves the code
  trade to `GH_WEB_URL`. With both settings empty, that is GitHub.
- **No email.** Sign-in asks for `public_repo` only, so reading `/user` is
  the one GitHub call it makes for a person. Better Auth's provider would
  also read `/user/emails`, which needs `user:email`, so we read the person
  ourselves. Better Auth's `user` row needs an email, so it gets a
  placeholder under `.invalid`.
- **Who is signed in** comes from Better Auth's session, then its user's
  GitHub account, whose `account_id` is the numeric GitHub ID, then that
  person in `people`. A request with no session cookie reads nothing, and
  with a sign-in setting missing, no one is signed in.
- **Cookies.** Better Auth puts `__Secure-` in front of cookie names over
  https. The `__Host-` prefix asks for more, so `useSecureCookies` is off and
  the names start with `__Host-gft`. better-call, which Better Auth builds
  on, sets `Secure` and `Path=/` and drops any `Domain` on every cookie named
  that way.
- **Forms, with no script.** The sign-in and sign-out buttons are plain
  forms, so they work before any script runs, like the nav. They post to our
  routes, which call Better Auth's API. Better Auth's own endpoints take JSON
  only, and every one of them but the callback answers 404.
- **Same-site forms.** Better Auth checks `Origin` only on the requests its
  router handles. Our form routes check it themselves, before the rate
  limit. Better Auth skips its own check when `NODE_ENV` is `test`, so it is
  turned on outright and the tests see it.
- **Cloudflare rate limiting,** through the `SIGN_IN_LIMITER` binding
  (`src/auth/rate-limit.ts`), counted per `cf-connecting-ip`, with an IPv6 address cut to its /64, and
  an IPv4 address written as IPv6 read as the IPv4 address. The MCP
  server's token endpoint counts against `TOKEN_LIMITER`, keyed the same way.
  Better Auth's own limiter is off, since it counts in each isolate's memory.
- **Development** is checked in `src/auth/settings.ts`: `ENVIRONMENT` and a
  loopback `http` `GH_WEB_URL` both. The dev sign-in and the stand-ins for
  the secrets depend on it.
- **Also off in Better Auth:** its IP address tracking, so no session stores
  an address, ID token sign-in, and telemetry.

### The MCP server

The rules are in [how-it-works.md](how-it-works.md#connecting-an-agent).

| File | What it does |
|---|---|
| `src/mcp/provider.ts` | Sets up the OAuth provider, which answers the OAuth routes and checks the token on `/mcp`, with the props each grant carries and the callbacks that check registrations and token requests |
| `src/mcp/server.ts` | The MCP server behind `/mcp`: the rate limit, the check that the agent is still connected, and the tools it serves, each run as the caller, the admin's to admins only |
| `src/mcp/donor.ts` | The donor's tools, under [The donor's tools](#the-donors-tools) |
| `src/mcp/submit.ts` | `submit_work`, `open_pr`, and the review queue `my_work` lists, under [The donor's tools](#the-donors-tools) |
| `src/mcp/maintainer.ts` | The maintainer's tools, under [The maintainer's tools](#the-maintainers-tools) |
| `src/mcp/admin.ts` | The admin's tools, under [The admin's tools and pages](#the-admins-tools-and-pages) |
| `src/mcp/apps.ts` | The views MCP Apps hosts show, as `ui://` resources, and the `_meta` that names each from its tool, under [The views for MCP Apps hosts](#the-views-for-mcp-apps-hosts) |
| `src/mcp/views/` | The views' own script and styles, which run in the host's frame |
| `src/mcp/authorize.ts` | An agent's sign-in: the rule for redirect URIs, the checks behind the page, the answer to its form, and GitHub's return |
| `src/mcp/consent.ts` | The server function that starts the page where a person approves an agent |
| `src/routes/oauth/authorize.tsx` | That page |
| `src/mcp/page-status.ts` | Sets the status that page names for itself |
| `src/mcp/connections.ts` | The `connected_agents` table, Disconnect, and ending connections whose grants ended |
| `src/mcp/agents.ts` | The server function that lists a person's agents on `/me` |
| `src/mcp/paths.ts` | The paths, with no imports, so pages can use them |

- **`@cloudflare/workers-oauth-provider` 1.1.0, pinned,** set up the way
  Cloudflare's `remote-mcp-github-oauth` example does it: one Worker is both
  the authorization server and the MCP server, with GitHub as the upstream
  sign-in. The library answers the protected-resource and
  authorization-server metadata, dynamic client registration at
  `/oauth/register`, and `/oauth/token`, and checks the access token on every
  request to `/mcp`. Every other request goes on to the site. The example is
  written for the library's 0.x releases and builds its own consent page and
  state cookies. The 1.x library has helpers for both, `beginConsent` through
  `finishUpstream`, which this uses.
- **One provider per origin.** The library needs the resource's full URL,
  `<origin>/mcp`, when it starts, and the site's origin comes from the
  request when there is no primary domain. So `src/mcp/provider.ts` keeps one
  provider for each origin, like Better Auth's instances.
- **What a grant carries.** The grant's props hold the connection's ID, the
  person's numeric GitHub ID, their login when the agent signed in, and the
  GitHub token. Its user ID is the GitHub ID, and its metadata holds the
  connection's ID, so Disconnect can find it. The library encrypts the props
  with a key it wraps with each of the agent's tokens, and keeps only hashes
  of those tokens.
- **A second copy of the GitHub token, in D1.** Disconnect has to revoke a
  grant's GitHub token without the agent, and the props open only with the
  agent's own tokens. So `connected_agents` keeps a copy, encrypted with
  `AUTH_SECRET` through Better Auth's `symmetricEncrypt`, the way the site's
  own token is stored. Anyone with a copy of D1 and `AUTH_SECRET` can read
  every agent's GitHub token with it, as they can every site token today.
  The code reads the copy only to revoke a token, and to check that a token
  it revokes isn't held twice. [The spec](specs/v1.md#3-identity-permissions-and-token-storage)
  says why the copy is kept: it is the one way to revoke exactly one agent's
  token without that agent.
- **A tool call needs its row.** Before a request reaches the MCP server,
  the handler updates the connection's last use in `connected_agents`, and
  answers `401` when there is no row. Deleting the row cuts the agent off at
  once, while a KV delete can take up to a minute to reach every location.
- **So do trading the code and refreshing.** The provider's
  `tokenExchangeCallback` runs each time the agent gets tokens. It records
  the grant's ID and the time in the row, as `grant_id` and `renewed_at`.
  With no row it throws `invalid_grant`, and the library deletes the grant.
- **A connection ends with its grant.** A grant can end three ways without
  Disconnect, and each would leave a live GitHub token in the row, so each
  ends the connection the way Disconnect does.
  - The agent revokes its refresh token at `/oauth/token`, which the
    library answers by deleting the grant. `src/server.ts` reads the token
    from the form before the provider answers, taking the form as a
    revocation the way the library does: a `token` and no `grant_type`, or
    an empty one. After a `200` it checks the
    grant's key, `grant:<user ID>:<grant ID>`, in `OAUTH_KV`. The library's
    helpers have no lookup by ID, and a KV list can miss a key made in the
    last minute. When the grant is gone, the row with that `grant_id` ends.
    An access token revoked alone leaves the grant, and the row stays.
  - The agent never trades its code, and the library's 10 minutes run out.
  - The agent goes 30 days without a refresh, and the grant runs out in KV.
  - The last two follow from `connected_at` and `renewed_at` alone, with a
    minute more for each. `endLapsedConnections` finds them for one person,
    when that person opens `/me` or connects an agent. No scheduled job runs
    it for everyone yet.
- **The MCP TypeScript SDK 2.1.0, pinned.** `@modelcontextprotocol/server`'s
  `createMcpHandler` serves both the 2026-07-28 protocol and 2025 clients,
  with a new `McpServer` for each request, so nothing is kept between
  requests and no Durable Object is needed. The example's `McpAgent` needs
  one. The tests use `@modelcontextprotocol/client` 2.1.0 as the agent.
- **The page is a TanStack route.** Its server function checks the request
  and starts the consent, and sets the library's headers: the cookie,
  `no-store`, and the two that keep the page out of frames. It never
  redirects. An error the agent should hear about gets a link back to the
  agent on the page, which only the person follows.
- **The page's status.** TanStack Start renders every page with `200`. So
  the server function names the page's status in the `x-gft-page-status`
  header, and `src/server.ts` sets it with `src/mcp/page-status.ts`, only
  when it is `400`, `429`, or `503`, and always removes the header.
- **The error page's reason** is a sentence the site wrote for each OAuth
  error code, with one for any other. The library's `error_description`
  repeats parts of the request, like its `response_type`, which anyone can
  write, so it goes only in the link back to the agent.
- **The server function has a URL of its own,** under `/_serverFn/`, which
  the client bundle names and anyone can call. So `openConsent` counts the
  sign-in limit itself, for the page and for each call there alike.
- **Redirect URIs.** The provider's `clientRegistrationCallback` refuses a
  registration with an `http` redirect URI to any host but `localhost`,
  `127.0.0.1`, or `[::1]`. The library refuses `javascript:`, `data:`, and a
  few other schemes itself. A scheme of an app's own stays allowed, since
  desktop harnesses sign in that way.
- **The upstream callback is `/auth/callback/mcp`,** under the same OAuth
  app's callback URL as the site's sign-in, as the spec plans.
  [self-hosting.md](self-hosting.md#3-create-the-github-oauth-apps) says how
  one app serves both.
- **Lifetimes.** Access tokens last the library's default hour. Grants use
  `refreshTokenTTL` and `refreshTokenIdleTTL` of 30 days, so a refresh
  extends one. Dynamically registered clients last the library's default 90
  days, and a client that keeps trading tokens keeps its registration.
- **No scopes.** The server declares none and grants none. What a caller may
  do is `requirePermission`'s to decide.
- **Client ID metadata documents are off.** The issue asked for dynamic
  registration, and the documents need the `global_fetch_strictly_public`
  compatibility flag, which changes how every outbound fetch from the Worker
  is routed. The library logs a warning that they are off when the Worker
  starts.
- **Cookies** are the library's, with the prefix `__Host-gft.oauth-`, which
  it requires to start with `__Host-`. It sets them `Secure`, `HttpOnly`,
  `SameSite=Lax`, and `Path=/`.
- **Rate limiting.** `MCP_LIMITER` counts each request to `/mcp` that has a
  valid token, by the person's GitHub ID, since agents on a shared host, like
  Grok Bot's, can share an address. An agent's sign-in counts against
  `SIGN_IN_LIMITER`, by address: `src/server.ts` counts registration before
  the library sees it, since each one writes a client to KV, `openConsent`
  counts the page, and the form and GitHub's return count where they are
  answered. So a shared host can register at most 20 clients a minute from
  one address.
- **The token endpoint has a limit of its own.** `TOKEN_LIMITER` counts each
  request to `/oauth/token`, by address, 600 a minute. A shared host
  refreshes many people's tokens from one address, and at 20 a minute some
  of them would fail.
- **Over a limit, the OAuth routes answer in OAuth's terms.** At
  `/oauth/register` and `/oauth/token` the answer is `429` with a JSON body
  whose `error` is `temporarily_unavailable`, `Retry-After: 60`, and
  `no-store`. `@modelcontextprotocol/client` 2.1.0 reads any other body as a
  server error, and on a refresh a server error makes it drop to a new sign-in
  in the browser, which a headless agent can't finish. With this body it
  throws, keeps its tokens, and can refresh again later. A request with an
  `Origin` gets the CORS headers the library puts on its own answers there,
  so an agent in a web page can read the error too. Without them the
  browser hides it, and the SDK starts a new sign-in.
- A request to `/mcp` with a token the library doesn't know gets its `401`
  after one KV read, and no limit here counts it.

### The maintainer's tools

The rules are in [how-it-works.md](how-it-works.md#registering-a-project).

| File | What it does |
|---|---|
| `src/mcp/maintainer.ts` | `register_project`, `update_project`, `project_status`, and `pause_project`. `project_status` with `refresh` runs the sync for its project, under [The sync](#the-sync) |
| `src/projects/repo.ts` | What registration reads from GitHub, the eligibility rule, and creating the `goodfirsttoken` label |
| `src/projects/docs.ts` | The files a repo's docs are read from, where each is looked for, and the size limit, for the proposal and the policy crawler alike |
| `src/projects/rules.ts` | The rules the proposal and the crawler share: labels that mean ready for help, the disclosure trailer, the person-written description, and the CLA link |
| `src/projects/proposal.ts` | The proposal's rules, as a pure function of the labels and the files |
| `src/projects/status.ts` | Who can lift a pause, and the status a resume puts back, for the maintainer's tools and the admin's alike |

- **One permission check, one read.** Every tool starts with
  `requirePermission(caller, 'manage_project', { repo })`, which reads the
  repo with the caller's token and keeps nothing. For `manage_project` it
  hands back the repo as GitHub described it, as a `ManagedRepo`, and other
  permissions hand back nothing. So `register_project` checks visibility,
  archived, and who can open PRs from that one read, and an issue repo other
  than the code repo goes through the same check, whose answer gives the
  name to save and whether the repo is archived.
- **Refusals and lost tokens.** `asCaller` in `src/mcp/server.ts` runs every
  tool. It turns a `PermissionRefused` into the tool's refusal, and a GitHub
  `401` from any call into the end of the connection.
- **Schemas from core.** Each tool is registered with its description and
  its input and output schemas from `packages/core`. The MCP SDK checks the
  input against the schema before the tool runs, and reports each issue's
  message with its field. Core's object schemas set their own message only
  for a value of the wrong type, so an unknown field keeps zod's message,
  which names it.
- **Reading the files takes two GraphQL queries.** The first lists the
  root, `.github/`, and `docs/` of `HEAD`, the default branch, with each
  entry's size. The second reads the files the listing found, each by an
  `object(expression:)` alias. The paths go in as GraphQL variables, so a
  file's name never becomes part of the query. Paths in a repo compare with
  case, and the rules match these names without it, so the listing is
  matched in code. Labels come from the REST API, 100 to a page.
- **The label is read before it is made.** `createOurLabel` asks for the
  label by name and creates it only on a `404`, and a `422` on the create
  is read again. When it runs, and what it does on a refusal, is under
  [the goodfirsttoken label](how-it-works.md#registering-a-project).
- **Taking over a listing** is `takeOverListing` in `src/db/projects.ts`. In
  one batch it adds the new settings version, when the settings changed, and
  sets the project's source, policy, and who added it. For a rejected
  listing it also adds a status change and sets the status to `pending`. No
  other takeover writes a status column. Every statement checks that the row
  is still a policy listing at the version and status read, so the project
  the call hands back is the one stored, and the save retries like
  `changeSettings`. A new registration uses `createProject`,
  whose insert does nothing when the repo became a project meanwhile, so
  the tool reads again and takes over or refuses. A rejected registration
  registered again is `reopenRegistration`, which checks the row the same
  way, against the rejection read.
- **The do-not-list changes with the status.** A registration leaves the
  list alone, so the admin who decides it sees the request to be removed.
  An approval runs `leaveDoNotListWhenApproved` from
  `src/db/do-not-list.ts` through `setProjectStatusFrom`'s `alongside`, a
  delete that applies only when the row is a registered project that this
  admin approved at this time. So the list and the status change in one
  transaction, and an approval that lost its compare-and-set takes nothing
  off.
- **A pause or resume is a compare-and-set.** `setProjectStatusFrom` writes
  the new status only while the project's status, reason, who set it, and
  when are the ones read, the way `changeSettings` checks the settings
  version. On a mismatch it writes nothing, and `pause_project` reads the
  project again and decides again, up to five times. The admin's tools make
  every status change the same way. A change to the status and reason
  already there writes nothing when the same person set them, and is a
  change of its own when someone else did, so an admin's pause over a
  maintainer's names the admin. `setProjectStatus` writes whenever the
  status or reason differs, and only the tests use it now.
- **Resuming reads the status history,** newest first, for the change
  before the pause. The project's row holds only its current status. A
  status change keeps who made it and no role, so whether a pause was an
  admin's is worked out when the maintainer resumes, as
  [Managing a project](how-it-works.md#managing-a-project) says.

### The donor's tools

The rules are in [how-it-works.md](how-it-works.md#the-donors-tools).

| File | What it does |
|---|---|
| `src/mcp/donor.ts` | `start_session`, `set_interests`, `suggest_issues`, `claim_issue`, `post_update`, `release_claim`, and `my_work` |
| `src/mcp/submit.ts` | `submit_work` and `open_pr`, and the review queue that `my_work` lists |
| `src/issue/find.ts` | `followedCopy`, which project's copy a claim goes to, for the issue page and `claim_issue` |
| `src/donor/rules.ts` | The donor's own rules: blocked, the open-PR cap, the CLA, and the vouch file, for `suggest_issues` and `claim_issue` alike, and whether a claim's project still takes work, for `submit_work` and `open_pr` |
| `src/donor/github.ts` | What the tools read from GitHub with the donor's token: the donor's reader, a project's code repo, and an issue with its linked PRs |
| `src/donor/writes.ts` | What `submit_work` and `open_pr` do on GitHub with the donor's token: fork, branch, read files, commit, compare, and open the PR |
| `src/donor/work.ts` | The submitted work's rules as pure functions: workflow paths, the review reason, the branch name, and the words of the commit and the PR |
| `src/donor/vouch.ts` | The vouch file's format |
| `src/donor/pick.ts` | Ranking against interests, and the random order with weight toward the top |

- **One rule for which issues take claims,** the SQL in
  `src/db/waiting.ts`, under The projects list and the project pages.
  `listWaitingIssues` in `src/db/projects.ts` lists the issues
  `suggest_issues` starts from with its `takesClaims`, and
  `slotsTaken` gives their slots taken. `claim_issue` gets each project's
  copy of an issue from `findIssue`, judged by `CLOSED_BECAUSE` there, and
  picks the one the issue page follows with `followedCopy`, so a claim goes
  to the project the page follows. `checkIssueOnGitHub` judges the labels
  an issue carries on GitHub now with `judgeLabels` in `src/db/issues.ts`,
  which runs `CARRIES_A_TAG` over them in D1. The do-not-list and the
  sync's mark come into it only through `ASKING_FOR_HELP`, the homepage's
  check. Its first half, `checkIssueFacts`, reads the issue's own facts,
  and `submit_work`, `open_pr`, and the review queue in `my_work` run it
  again, with the donor let through as the issue's assignee.
- **One place for the donor's rules.** `src/donor/rules.ts` checks the
  rules spec section 6 sets for the donor. `suggest_issues` and
  `claim_issue` both call it, and each returns a refusal or nothing.
- **The donor's token for every read.** `donorReader` wraps the donor's
  token in `GitHubReader`, the interface `ServiceGitHub` has in
  `src/sync/github.ts`, so `closingReferences` and `crossReferences`, the
  sync's reads of linked PRs in `src/sync/issues.ts`, run with it
  unchanged, with the sync's rule for which PRs count. It has no budget of
  its own to keep: a donor's calls count against the donor's own rate
  limit on GitHub, and a refusal, a `401` included, goes back as
  GitHub's error. A GraphQL answer that says the rate limit ran out is a
  refusal too.
- **One query for a project's repo.** `readRepoFacts` reads the head of
  the default branch, the donor's `viewerPermission`, and both places the
  vouch file can be, each by an `object(expression:)` alias, in one
  GraphQL query. The head is where the claim's work starts. `ADMIN` or
  `MAINTAIN` makes it own-project work, and `WRITE` or more counts as
  vouched for, under the vouch file's format below.
- **An issue on GitHub** is one REST read, `GET /repos/{owner}/{repo}/issues/{n}`,
  which gives its state, labels, assignees, and text, and says whether the
  number is a pull request. Then one GraphQL query for its closing
  references and the REST timeline for its mentions, as the sync reads
  them.
- **The vouch file's format** follows the
  [vouch README](https://github.com/mitchellh/vouch/blob/main/README.md),
  its parser, [`vouch/file.nu`](https://github.com/mitchellh/vouch/blob/main/vouch/file.nu),
  and its check, `check-user` in
  [`vouch/lib.nu`](https://github.com/mitchellh/vouch/blob/main/vouch/lib.nu),
  read on 2026-09-27, and
  [Ghostty's own file](https://github.com/ghostty-org/ghostty/blob/main/.github/VOUCHED.td),
  which sets out the same syntax in its header. vouch's command line looks
  for the file at `VOUCHED.td`, then `.github/VOUCHED.td`. Its GitHub
  checks, the ones that gate issues and PRs, read `.github/VOUCHED.td`
  unless told another path, in
  [`vouch/github.nu`](https://github.com/mitchellh/vouch/blob/main/vouch/github.nu).
  We read `.github/VOUCHED.td` first, then the root. Those checks also let
  a collaborator with admin or write access through before they read the
  file, and we count GitHub's `WRITE`, `MAINTAIN`, and `ADMIN` as vouched
  for too. We read the file first all the same, so a line that denounces a
  collaborator refuses them. vouch reads a line
  trimmed, takes a leading `-` as a denouncement, splits the handle from
  the details at the first space, lowers the handle, and splits a platform
  off at the first `:`. Its check takes the first line that names the
  person, and a line with no platform matches any platform. The files it
  writes name each person once. We split the handle at any white space,
  and a denouncing line counts over a vouching one, so a file that names
  someone both ways refuses them.
- **The CLA** is kept in `cla_confirmations`, one row per donor and project
  with the link confirmed, which a confirmation of a new link replaces. The
  project's settings keep the link, so a changed link no longer matches the
  row, and the donor is asked again.
- **The queue lives in the session,** as `donor_sessions.queue`, a JSON
  list. `claim_issue` changes it only through `editSessionQueue`, which
  reads the list, applies the change, and writes it with an update that
  lands only on the list it read, trying again up to five times, as the
  budget does. After a walk, the change takes out the pick claimed and the
  ones passed over, and a pick it stopped at stays first. So two calls in
  one session at the same moment each apply their change to the list the
  other left.
- **The budget holds under claims at the same moment.** `takeSessionIssue`
  reads the session, checks core's `budgetLeft`, and counts the issue with
  an update that lands only on the count it read, trying again up to five
  times. The count comes before the room's claim, and goes back with
  `returnSessionIssue` when no new claim is made. A call that dies in
  between leaves the count one high.
- **The random order is drawn as the walk goes.** `weightedOrder` is a
  generator. It keeps a window of the first 12 issues not drawn yet, draws
  one when the walk asks for the next, and lets the next issue down into
  the window. So a walk that stops after a few issues makes a draw for
  each of them alone, however many issues wait, and it can still walk past
  any number of issues it passes over. The walk stops at 3 suggestions, 8
  checks of issues on GitHub, or the end. It reads each project once, up
  to 20, and a project that keeps the donor out takes no checks.
  `suggestIssues` takes the random source as an argument, `Math.random`
  from the server, and the tests stub `Math.random` in the Worker's
  isolate, which they share. Calls at the same moment draw as their walks
  go, in whatever order their reads finish, so the test of spreading asks
  one call at a time.
- **Finding a claim's room.** `post_update` and `release_claim` take a claim
  ID, and the room is named for the issue, so they read the claim from the
  claims table first. The room saves a claim to D1 before its answer to
  `claim_issue` goes out, unless D1 refuses the save, so a claim the agent
  knows of is in the table.
- **Unfinished claims** come from the claims table, advanced to now with
  `nextClaimState`, and each is read again from its room's `snapshot`,
  which is the source of truth when D1 lags behind.
- **What a call costs.** `suggest_issues` makes six D1 reads: the
  session, the donor with their interests, their block, their claims,
  their open PRs by project, and one list of every waiting issue. Then one GitHub
  GraphQL query for each project it reads, up to 20, and for each issue it
  checks, one REST read, one D1 read for its labels, one GraphQL query, and
  one timeline page or more, for 0 to 8 issues. Then one D1 read for the
  claims on the issues suggested, one for the blocks among their claimants,
  and one for each claimant. `claim_issue` makes the reads `findIssue`
  makes, a room `snapshot`, a few D1 reads for the session, the donor, the
  budget, the open PRs, the issue's labels, and the CLA, one GraphQL query
  for the repo, the issue's three or more GitHub reads, and the room's
  `claim`. The list of waiting issues reads every
  approved project's cached issues, through `projects_by_status` and the
  key of `tagged_issues`. Nothing caches any of it yet.
- **A submit checks before it writes.** `workOn` in `src/mcp/submit.ts`
  reads the claim from the claims table, checks `work_claim`, the block,
  and the project with `projectClosedRefusal`, whose do-not-list check is
  `doNotListedProjects`, the one `claim_issue` uses, and asks the claim's
  room whether the claim can take the event now. Only then is a
  `DonorWriter` made with the donor's token, so a refusal makes no call to
  GitHub.
- **Push access** is the repo's `viewerPermission` from `readRepoFacts`,
  the query a claim makes, which also gives the default branch's name for
  the PR. A linked PR is read with `linkedPrs` in `src/donor/github.ts`,
  which `checkIssueOnGitHub` uses too: the sync's `closingReferences` and
  `crossReferences`, with the donor's token.
- **The fork** is `POST /repos/{owner}/{repo}/forks` with
  `default_branch_only`, which GitHub answers with the fork the donor has,
  whatever its name, or a new one. The branch is `POST .../git/refs` at the
  start commit. A fork can point at it, since a fork network shares its
  objects on GitHub. GitHub answers 409 for a repo it is still making, and
  the server waits 0.5, 1, and 2 seconds between reads with `setTimeout`,
  so a submit to a new fork can take about 4 seconds more. A Worker's wait
  uses no CPU time.
- **Working out the change.** The folders on the way to each path are
  read at the branch head, or at the base while there is no branch, a
  level at a time from the root, with one GraphQL query for each 100
  folders of a level, `object(expression:)`, and the folders as
  variables: each entry's name, type, mode, blob ID, and size. A level
  reads only the folders the level above has, so the reads follow the
  repo's own folders, and nothing is read past the first folder a path
  makes new. A path five folders deep costs six queries, one after
  another, and a path is at most 20 folders deep, so no submit costs more
  than 21 levels. Tree entries are the one place GitHub gives a file's
  mode. A folder's entries come back whole, so a path in a folder of
  thousands of files reads all their names, which the case check uses
  too. A file whose new text has the same size in UTF-8 as the one there
  is read in full in a second query and compared. A change to an entry
  whose mode is 100755, 120000, or 160000 is refused with `file_mode`
  before anything is written.
- **Putting back.** A path to put back is read at the base, the start
  commit in the code repo or the head an `onto` named in the branch's
  repo, compared with the branch by blob ID, and its bytes read with
  `GET .../git/blobs/{sha}`, so a binary file goes back as it was.
  `submissions.paths` keeps the paths the latest submit sent, for the
  next, and `submissions.base` the base.
- **Modes.** GitHub's docs call `TreeEntry.mode` the entry's file mode, an
  `Int`, and don't say how it is written. The fake gives the number the
  octal mode reads as, 33188 for 100644, and the check also takes the
  digits read in decimal, 100755, 120000, and 160000, so either is caught.
  Neither is checked against GitHub.
- **The branch's head** is read with `GET .../git/ref/heads/{branch}`, and
  compared with `submissions.commit_sha`, or the start commit before a
  first submit, or `onto`. A head that differs is read with one GraphQL
  query for its parents and its author's login, `commitFacts`. Only a
  commit with one parent, the expected head, and the donor as its author
  can be a submit that died after its commit. `onto` with no branch is
  refused before `createBranch`, which only ever takes the base: the start
  commit, or a head an earlier `onto` checked against the branch. A submit
  with `onto` past someone's push also reads the submitted paths at the
  commit before the push, and the text of the ones the push changed, to
  find a file that would go back to how it was.
- **The workflow rule** reads the paths from the same comparison that
  counts the lines, each file's `filename` and a rename's
  `previous_filename`, beside the submitted ones. Once the claim's base is
  a head someone else pushed, a comparison GitHub doesn't give, or one of
  300 files, which may leave one out, sends the work to review.
- **The commit** is `createCommitOnBranch` with `expectedHeadOid` set to the
  head the change was worked out from, and each file's text in base64.
  GitHub's `STALE_DATA` means the branch moved, and the branch is read
  again, up to three tries.
- **Recording.** The room records the submit after the commit lands. Then
  the lines come from `GET .../compare/{main}...{commit}` in the repo the
  branch is in, where `{main}` is the head of the code repo's default
  branch that `readRepoFacts` read, which a fork's network has. A
  three-dot comparison runs from the merge base, so it counts the PR's own
  change. `submissions.diff_from` keeps that head for the review queue's
  diff. The comparison lists up to 300 files, and `saveSubmission` writes
  the row. A PR goes to the room with `openPr`, then to `prs` with
  `addPr`. A call that dies after its commit leaves the commit on the
  branch unrecorded. The same submit again finds the donor's own commit on
  the expected head, holding the files, and records it. When the claim's
  room has a first submit and `submissions` has no row, the room already
  recorded it, and it isn't recorded there again. Two calls at once with
  the same files take the one commit by the same rule, and the room
  records both, since it keeps no commit to tell them apart. A PR, likewise,
  is found by `GET .../pulls?head=`, since GitHub answers a PR already open
  from the branch with a 422 whose message names no reason.
- **What a submit costs.** A first submit to a fork of files two folders
  deep makes about 14 calls to GitHub: the repo, the issue, the fork, the
  branch, a GraphQL read of each folder level on the way to the files and
  one of their text, the new branch, the commit, the comparison, the
  issue's closing references and timeline, and the PR. Each path put back
  adds a blob read.

### The admin's tools and pages

The rules are in [how-it-works.md](how-it-works.md#the-admin-queue).

| File | What it does |
|---|---|
| `src/admin/actions.ts` | The admin's actions: the queue, deciding, listing from a policy, blocking, pausing, removing, and the crawler's seed list |
| `src/mcp/admin.ts` | The admin's MCP tools, each an action's answer as a tool result |
| `src/admin/page.ts` | What `/admin` reads, and the answer to its forms |
| `src/admin/data.ts` | `getAdminPage`, the server function the route's loader calls |
| `src/admin/paths.ts` | The page's path, with no imports, so pages can use it |
| `src/routes/admin.tsx` | The page, built from the components in `src/components/`, and the route's `POST` handler |
| `src/styles/admin-page.css` | The page's layout and its form fields |

- **One set of actions.** The MCP tools and the page's forms call the same
  functions in `src/admin/actions.ts`, with a `Caller`: the agent's grant,
  or the web session through `siteCaller` in `src/auth/session.ts`. Each
  action calls `requirePermission` before it reads or writes anything, and
  answers with the tool's output from core or a refusal.
- **Listed for admins only.** `buildServer` is async and asks
  `requirePermission` for `review_projects` on every request, and registers
  the admin tools only when it passes. A tool that isn't registered is one
  the SDK refuses to call.
- **Queue IDs.** A crawler find's ID is its candidate ID. A registration's
  is `reg_` and the ID of its latest row in `project_status_changes`, which
  `listPendingProjects` reads with each pending project, so the queue needs
  no table of its own, and `getPendingProject` finds the project only while
  that change is still its latest.
- **The repo's facts** for a registration come from two REST calls with
  the admin's token, `GET /repos/{owner}/{repo}` and `GET /users/{owner}`,
  in `readStanding` in `src/projects/repo.ts`. Every registration's are
  read at once, so the queue costs two GitHub calls for each registration,
  on every read of the queue. Only a `404` for the repo gives
  `factsMissing: 'not_public'`. Any other failure, the owner's `404`
  included, gives `no_answer`, logged with `console.warn`, in
  `factsFromGitHub`. A `401` goes on up, so an agent's connection ends,
  and the page reads the queue again with no token and says to sign in
  again.
- **Every status change is a compare-and-set,** through
  `setProjectStatusFrom`, retried up to five times, as for the maintainer's
  pause. So a maintainer's pause or resume that lands at the same moment as
  an admin's never undoes it.
- **Editing a listing** is `relistFromPolicy` in `src/db/projects.ts`,
  which applies the settings sent over the listing's, with
  `updateProjectSettings`, and checks the listing's source and settings
  version in the same statements as its writes, the way `takeOverListing`
  does.
- **The do-not-list is checked in SQL.** A listing from a policy reads the
  list before it asks GitHub, and again before each write, and the writes
  check it too: `createProject`'s insert and `relistFromPolicy`'s
  statements carry `NOT EXISTS (SELECT 1 FROM do_not_list WHERE repo = ?1)`,
  so the check and the write are one step. A removal adds the entry on its own, before
  anything else, and its rejection runs `doNotListWhenRejected` in the same
  batch, through `setProjectStatusFrom`'s `alongside`, which adds the entry
  again only when that rejection landed. So an approval that took the
  repo off the list between them can't leave a removed project off it.
- **Blocked donors** come from `listBlocks`, one query that joins
  `donor_blocks` to `people` for each login.
- **Forms, with no script.** The page's forms post to `/admin`, which the
  route answers with a `server.handlers.POST`, and TanStack Start leaves
  `GET` to the page. The handler checks `Origin` first, then the session
  and `review_projects`, and sends the admin back to `/admin` with `303`.
  Rejecting needs a reason, which the textarea's `required` asks for, and
  the approve button skips with `formnovalidate`. The handler checks it
  too, through the tool's input schema from core.
- **Notices in the address.** The page says what a form did with a notice
  in the address it sends the admin back to, beside an HMAC-SHA256 of it
  keyed with `AUTH_SECRET`. The server function shows the notice only when
  the signature matches, so a link made elsewhere can't put words on the
  page. The notice's dismiss link is a router link, so it reads the page's
  data again through the server function.
- **The server function** runs `loadAdminPage`, which reads the session
  and checks the permission before anything else, and answers
  `signed_out` or `not_found` with no data. The route turns those into a
  redirect to `/sign-in` and a `404`. So calling the server function on its
  own, under `/_serverFn/`, gives a non-admin nothing, which an end-to-end
  test checks by replaying the page's own call as someone else.
- **The nav's admin link** comes from `getViewer`, which checks
  `review_projects` with no token and reads nothing more.
- **A sample admin in development.** `adminGithubIds` adds the GitHub
  fake's `@sample-admin` when `isDevelopment()` holds, the check the dev
  sign-in and the secret stand-ins use. So `pnpm dev` and the end-to-end
  tests have an admin, and `wrangler.jsonc` names none.

### The views for MCP Apps hosts

The rules are in [how-it-works.md](how-it-works.md#views-in-mcp-apps-hosts).

| File | What it does |
|---|---|
| `src/mcp/apps.ts` | Which tools have a view, each view's resource and `_meta.ui`, its page, and `registerViews`, which `buildServer` calls |
| `src/mcp/views/main.ts` | The views' one script: it picks the view from `<body data-view>`, waits for the answer, and draws it |
| `src/mcp/views/bridge.ts` | The view's side of the extension: JSON-RPC over `postMessage` with the host |
| `src/mcp/views/cards.ts`, `live.ts`, `review.ts` | The issue cards, the live feed, and the review queue |
| `src/mcp/views/parts.ts`, `dom.ts` | The pieces the three share, and the one function that makes elements |
| `src/mcp/views/view.css` | The card, and the dark colors |
| `scripts/mcp-views.ts` | The Vite plugin that builds the script and styles for the Worker |
| `scripts/apps-host-proxy.ts` | `pnpm apps:host`, which lets the reference host reach `pnpm dev`, under [Trying the views in basic-host](#trying-the-views-in-basic-host) |
| `src/feed/follow.ts` | Following a feed's socket from a browser, for pages and views alike |

- **Built against the extension's stable spec of 2026-01-26,**
  [`specification/2026-01-26/apps.mdx`](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
  in modelcontextprotocol/ext-apps, read with its SDK,
  `@modelcontextprotocol/ext-apps` 2.0.3, on 2026-09-29. A view speaks
  protocol version `2026-01-26`.
- **The SDK and the MCP SDK.** The extension's server helpers,
  `registerAppTool` and `registerAppResource`, take
  `@modelcontextprotocol/server` 2.x as a peer, which 2.1.0 is, and only add
  the MIME type and `_meta` through `McpServer`'s own `registerTool` and
  `registerResource`. `apps.ts` does the same with 2.1.0's API, so the Worker
  takes no new dependency. The SDK's `App`, the view's side, brings zod and
  the MCP SDK's protocol with it, 418 KB bundled. A view needs a handful of
  messages, `ui/initialize`, the tool's input and answer, `tools/call`,
  `ui/open-link`, `ui/message`, `ui/update-model-context`, and its size, so
  `bridge.ts` speaks them itself, in the shapes the SDK's schemas check, as
  the spec allows. The reference host from the same repo, `basic-host` at
  2.0.3, which uses the SDK's `AppBridge`, runs the views against
  `pnpm dev`: a Pick claims, the card follows the issue live, and Open PR
  opens a PR on the GitHub fake. The steps are under
  [Trying the views in basic-host](#trying-the-views-in-basic-host).
- **Every agent gets the views, by choice.** The spec says a server should
  register views only for a client that declares `io.modelcontextprotocol/ui`
  among its capabilities. The server could check. A request in the
  2026-07-28 protocol carries the client's capabilities. A 2025-era client,
  which the MCP client SDK is unless told otherwise, declares them only in
  `initialize`, a request of its own. `createMcpHandler` builds a new server
  for each request, so the server would keep them with the agent's
  connection, to read at each `tools/list`. It does neither, since the
  reference host, `basic-host` 2.0.3, declares no capability for the
  extension, and a check would hide the views from it. So what a host
  without MCP Apps sees is kept small: a
  `_meta` on three tools, which the spec makes safe to ignore, a `resources`
  capability, and an empty `resources/list`. `registerViews` leaves the
  views out of it, as the spec allows for resources only a view uses, and a
  host reads each view by the URI its tool names. Every answer is the same
  for every host.
- **One page per view, built with the Worker.** `import view from
  './views/main.ts?mcp-view'` gives the Worker a script and styles as
  strings. `scripts/mcp-views.ts` answers that import with a Vite build of
  its own: the entry and what it imports, as one minified script, and the
  styles it imports, which are the design system's `tokens.css`, `base.css`,
  and `components.css`, and `view.css`. Vite puts a file the styles name,
  like a font, into them as a `data:` URL, so the plugin checks what it
  built. The build fails when the styles name a file with `url()` or pull
  in a stylesheet with `@import`, since a view loads nothing, or when the
  script and styles pass `MAX_VIEW_BYTES`, 64 KB. `vite.config.ts` and
  `vitest.config.ts` both load the plugin, so `pnpm dev`, the build, and the
  tests serve the same pages. `viewHtml` puts the two in one HTML page per
  view, which differ only in `<body data-view>`. Each is about 36 KB, and
  the Worker builds none at request time.
- **The views reuse the site's code where it runs without zod:**
  `followFeed` for the socket, which `useLiveFeed` wraps for pages,
  `toWallLine` from the homepage, and the tools' text helpers from
  `@goodfirsttoken/core/text`, a subpath of the core package with no import
  that runs. Every other import from core is a type. So a view checks a
  socket's message by the fields it shows, where a page checks it with
  `feedEventSchema`. The room checked each event before it stored it.
- **The socket's origin comes from the request.** A view's socket runs to
  the live page the tool's answer names, and `viewMeta` declares the same
  origin, `siteOrigin(request)` as `ws:` or `wss:`: the primary domain from
  the deployment's settings, or the request's own origin in development.
  No config names it. The socket is public and reads no cookie, so a view's
  frame may open it from whatever origin the host gives it.
- **Text stays text.** `h` in `dom.ts` adds every string as a text node,
  refuses an attribute that starts with `on`, and no view sets
  `innerHTML`. A link is a button that asks the host to open the page with
  `ui/open-link`, since a sandboxed frame can't open one, so no URL from an
  answer lands in an attribute. `webLink` in `dom.ts` takes an `https` URL,
  or an `http` one on this machine, as in development, and a live page's
  socket follows the same rule. Any other address shows as text. When the
  host won't open a page, its address shows beside the link, to copy.
- **Only the host talks to a view.** `bridge.ts` takes a message only from
  `window.parent`, the window that framed the view. Another frame on the
  page can't answer a view's call or set its theme.
- **The agent hears of a view's action.** A Pick sends `ui/message`, which a
  host adds to the conversation as the donor's, so the agent takes the
  claim up, and asks the donor for special instructions first, as after a
  pick in the terminal. Open PR sends `ui/update-model-context`, which the
  agent reads at its next turn. Each update takes the place of the one
  before it, so each names every PR the queue opened so far. A host can
  refuse a request with an error, or with a result that says `isError`,
  and a view takes both as a refusal.
- **The first answer only.** A host sends the input and answer of the call
  it framed the view for, and may send those of the view's own tool calls
  after them. `main.ts` draws the first ones, and each button shows its own
  call's answer. A change of the host's context holds only what changed, so
  `main.ts` merges each into what it has, and the theme stays until a
  change names another. When the host takes the view down with
  `ui/resource-teardown`, or the view draws again, it closes its sockets.
  When the host won't start it, the view says so.
- **The host's policy.** A view's script and styles are inline, which the
  spec's default policy allows with `'unsafe-inline'`. It asks for no
  permission, no frame, and no resource domain.

#### Trying the views in basic-host

The reference host from the extension's repo shows the views against
`pnpm dev`, by hand. It isn't a dependency of this repo. It connects to an
MCP server with no sign-in, so `pnpm apps:host` signs a sample person's
agent in to the site, as a harness does, and serves the site's `/mcp` on
`http://localhost:3001/mcp`, the address `basic-host` connects to unless
told otherwise, with that agent's token and the CORS headers a browser
needs. Anything that reaches its port acts as that person, so it takes
only a site on this machine, listens on this machine alone, passes on only
`/mcp`, always to that site, and answers only pages on this machine. A test
checks that no request can send the token to another host or path.

1. Clone the extension's repo at 2.0.3, `git clone --branch v2.0.3 --depth 1
   https://github.com/modelcontextprotocol/ext-apps`, and copy
   `examples/basic-host` out of it, since inside the repo it builds against
   the repo's own packages.
2. In the copy, `npm install`, then build its two pages with
   `INPUT=index.html npx vite build` and `INPUT=sandbox.html npx vite build`.
   Its own `npm run build` needs tools from the repo's root.
3. Start it with `node serve.ts`. It serves the host on port 8080, and the
   sandbox its frames load on port 8081.
4. In this repo, run `pnpm dev`, then `pnpm seed`, then `pnpm apps:host`,
   which signs in as `@lena`. `--login` names another sample person,
   `--port` another port, and `--site` another local site. For another
   port, start `basic-host` with `SERVERS='["http://localhost:<port>/mcp"]'`.
5. Open `http://localhost:8080`. Pick a tool, fill its input as JSON, and
   press Call Tool: `start_session`, `set_interests` with a sample project,
   `suggest_issues` with the session for the issue cards, and Pick one.
   `post_update` sends a line the card shows live. `claim_issue` shows the
   live feed, `submit_work` and then `my_work` show the review queue, and
   Open PR opens the PR on the GitHub fake. The sun and moon button at the
   bottom switches the host between light and dark.

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
- **The launch video links these stylesheets too.** How it draws the site's
  pages with them is in [video/README.md](../video/README.md).
- **So do the views MCP Apps hosts show,** inline, under
  [The views for MCP Apps hosts](#the-views-for-mcp-apps-hosts). They build
  their elements with the components' class names in plain script, since
  React would be most of each page. Their dark colors, in `view.css`, are the
  prompt box's code tokens, and mixes of them, so the design system keeps one
  palette in `tokens.css`.
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
  the do-not-list, `feed.ts` feed events, `refusals.ts` the refusal codes,
  `secrets.ts` the check that replaces keys and tokens in posted text, and
  `validation.ts` the check that names the field in every problem.
- **Each MCP tool is a spec** in `src/tools/`, one file each for donors,
  maintainers, and admins: who sees it, a description for agents, input and
  output schemas, and a function that renders the output as text. Each
  maintainer's and admin's tool, and the donor's `submit_work` and
  `open_pr`, also lists, in `refusals`, every refusal code an agent can get
  from it. The skills are checked against those lists, under
  [Skills and plugins](#skills-and-plugins). The donor's other tools can
  add theirs when their skills name them.
  `src/tools/index.ts` lists them all, and its `toolResult` and
  `toolRefusal` build MCP results without depending on the MCP SDK.
- **`@goodfirsttoken/core/text` is the tools' text helpers alone,**
  `src/tools/text.ts`, which imports nothing that runs. The views MCP Apps
  hosts show use it, so their script carries no zod.
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

### What the skills name

A skill tells an agent which tools to call and what to do with each
refusal, so a skill and the server can drift apart. Two checks hold them
together.

- **`apps/web/test/mcp/skills.test.ts`** reads each skill's source, which
  `vitest.config.ts` reads in Node and passes in as `TEST_SKILLS`. It
  connects the agent of the person the skill is for, a maintainer with no
  admin role for maintain and the sample admin for admin, and lists that
  agent's tools from the server with their schemas. The tools a skill calls
  are the ones of its own audience, from their specs in `packages/core`.
  - The skill's `## Connect` section tells an agent how to add the server in
    its own harness, in that harness's words. There only a snake_case name
    alone in backticks is checked, and it has to be a tool the reader is
    served.
  - In the rest, sentence by sentence, every snake_case name has to be a
    tool the reader is served, a value in the schemas of the tools the
    skill names, like `too_soon`, or a refusal on the `refusals` list of a
    tool the skill calls, or of a tool named in the same sentence, as when
    the admin skill says what a maintainer gets.
  - Every word in backticks on its own, and every key in a JSON object in
    backticks, has to be a field or value in those schemas, like `prMode`.
    JSON's literals and `goodfirsttoken`, our label and plugin, are the
    only other words allowed. In a sentence that names tools, as in
    "`admin_block_donor` with `login`", each has to be a field, value, or
    refusal of one of those tools. A value after a field, as in
    "`prMode` `reviewed`", has to be one that field takes, when the field
    takes a fixed set: an enum, or true or false. A value after a free
    field, like `id`, isn't checked.
  - The `## Refusals` section has one entry, a list item that starts with
    the code in backticks and a colon, for each refusal on the lists of the
    tools the skill calls, and no other.
  - Each line of a code block is a call, `tool {json}`, to a tool the skill
    calls, whose input schema from `packages/core` takes the JSON. The
    Refusals entries and the code blocks are the only places the audience
    limits what a skill calls. Prose that tells an agent to call another
    tool its reader is served, like `start_session`, passes.
  - Each sentence the skill quotes in backticks, one that starts with a
    capital and ends with a full stop, like `Listed from its AI policy.`,
    has to be one of the strings in the code that writes the MCP tools'
    answers, or part of one. `vitest.config.ts` reads every string, and
    each fixed part of every template, in `packages/core/src/tools/`,
    `packages/core/src/projects.ts`, `src/projects/`,
    `src/auth/permissions.ts`, `src/mcp/server.ts`, `maintainer.ts`,
    `admin.ts`, and `donor.ts`, and `src/admin/actions.ts`, and passes them
    in as `TEST_ANSWER_TEXT`. Comments and the admin pages' text aren't
    read. Those files also hold strings no answer shows, like internal
    errors and logs, so a quote of one of them passes too. Answer text
    from other files isn't read, like the sync's pause reasons that
    `project_status` repeats, so a skill can't quote it yet. Server text
    built from parts at run time, like `Tool admin_queue not found`, isn't
    checked. At least one sentence
    across the skills has to be checked, so the test can't pass on none.
  - The skill calls every tool of its audience, and each tool it calls has
    a `refusals` list.
- **Every tool call in the MCP tests** goes through `mcpClient` in
  `test/mcp/helpers.ts`, which fails the test when a tool refuses with a
  code its `refusals` list leaves out. Every code on the lists has a test
  that gets it through `mcpClient`, so a list can't fall behind the server.
  A refusal no agent can get, like `not_admin` from an admin's tool, stays
  off the lists.

### Following the skills' steps

`pnpm skills:run` runs `apps/web/scripts/skill-run.ts` against a site in
development, `pnpm dev` unless `--site` names another. It follows the steps
of the maintain and admin skills with the MCP client SDK as each person's
agent. No model runs, so it spends no tokens.

- The GitHub fake's `sample-maintainer` registers
  `sample-owner/sample-parser`, a sample repo no sample work touches, and
  confirms the proposed settings as they are. `sample-admin` finds the registration with `admin_queue`,
  checks it carries those settings, and approves it with `admin_decide`.
  Then `project_status` has to say it is approved.
- Each person approves their agent over plain HTTP, the way a browser would:
  the site's page to approve the agent, then the GitHub fake's sign-in page.
  The run's requests carry a `cf-connecting-ip` of its own, so its sign-ins
  don't count toward anyone else's limit.
- A repo can be registered once. When an earlier run on the same database
  left the project, the admin's agent first removes it with
  `admin_remove_project`, and the run registers it again, as a rejected
  registration.
- `e2e/skills.spec.ts` runs the same steps against the end-to-end tests'
  preview, the Worker and the GitHub fake as servers of their own, as in
  `pnpm dev`. So CI runs them on every pull request, and a person can run
  them against `pnpm dev` and read each call and its answer. Runs of real
  harnesses stay by hand, since they spend real tokens.

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
  server lists the admin tools only to admins, and checks that the caller
  is an admin on every admin tool call.
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
| `OAUTH_CLIENT_ID` | Variable: the GitHub OAuth app's client ID. The GitHub fake's app locally | Now, by `src/auth/` |
| `ADMIN_GITHUB_IDS` | Variable: admins' numeric GitHub IDs, separated by commas | Now, by `src/auth/permissions.ts` |
| `GH_API_URL` | Variable: GitHub's REST and GraphQL API. The GitHub fake locally. Empty means `https://api.github.com` | Now, by `src/github.ts` |
| `GH_WEB_URL` | Variable: github.com itself, for OAuth sign-in. The GitHub fake locally. Empty means `https://github.com` | Now, by `src/auth/` |
| `DB` | D1 | Now, by `src/db/`, Better Auth, `src/mcp/connections.ts`, the issue room, the feeds, the text streams, the scheduled jobs, and the crawler |
| `SIGN_IN_LIMITER` | Rate limiter: 20 requests a minute for each client address. Its namespace ID is a placeholder locally, which a deploy replaces | Now, by `src/auth/rate-limit.ts` |
| `MCP_LIMITER` | Rate limiter: 120 requests to `/mcp` a minute for each person. Its namespace ID is a placeholder locally, which a deploy replaces | Now, by `src/mcp/server.ts` |
| `TOKEN_LIMITER` | Rate limiter: 600 requests to `/oauth/token` a minute for each client address. Its namespace ID is a placeholder locally, which a deploy replaces | Now, by `src/auth/rate-limit.ts` |
| `ISSUE_ROOM` | Durable Object namespace of `IssueRoom`, one per issue | Now, by the issue's text stream and page, the scheduled jobs, and the donor's tools |
| `FEED` | Durable Object namespace of `Feed`: the homepage's, one per project, and one per person | Now, by the feed queue's consumer and the text streams |
| `OAUTH_KV` | KV: the OAuth library's clients, grants, token hashes, and sign-ins in progress | Now, by `@cloudflare/workers-oauth-provider`, through `src/mcp/` |
| `FEED_QUEUE` | Queue producer. The Worker also consumes the queue, with `feed-dlq` as its dead-letter queue | Now, by the issue room and `src/feed/queue.ts` |
| `CRAWL_QUEUE` | Queue producer. The Worker also consumes the queue, one batch at a time, with `crawl-dlq` as its dead-letter queue | Now, by the crawler's search and `src/crawl/queue.ts` |

The cron triggers are in `wrangler.jsonc` too, under `triggers`, and
[The sync](#the-sync) lists them, the crawler's included. The static host's R2 bucket is not a
binding, since the Worker never reads it.
[The static host](#the-static-host) covers it.

A Durable Object class gets its storage from an entry under `migrations` in
`wrangler.jsonc`. `IssueRoom`, at tag `v1`, and `Feed`, at `v2`, are under
`new_sqlite_classes`, so their storage is SQLite. A migration that has run
on a deploy never changes, and a new class is a new entry with the next
tag. Class and binding names are code, so
they are in the file. Cloudflare keeps each class's objects under the
Worker's name, so no setting names them.

## Database

D1, bound as `DB`, holds the structured records that search and the
leaderboard read: people, projects with their settings and status changes,
the tagged-issue cache, claims, their submitted work, PRs, donor sessions,
blocks, the do-not-list, crawl candidates, and the crawler's seed list and
passes. GitHub is the source of truth for issues
and PRs, and the issue room is for claims, so those tables are caches and
mirrors. None of these tables holds a GitHub token. The rules these records
follow are in [how-it-works.md](how-it-works.md#people), under
People through Crawl candidates.

It also holds Better Auth's four tables for signing in, described under
[Better Auth's tables](#better-auths-tables). The one GitHub token they store,
in `account`, is encrypted. And it holds `connected_agents`, the agents each
person connected to the MCP server, described under
[The MCP server](#the-mcp-server). Each row keeps its agent's GitHub token,
encrypted the same way.

| Table | One row per | Key |
|---|---|---|
| `connected_agents` | Agent a person connected: the client it registered as and the name it gave itself, its GitHub token, encrypted, when it connected, when it last called a tool, and its grant with when it last got tokens from it | `id` |

Migration `0003_connected_agents.sql` makes it. `src/mcp/connections.ts`
reads and writes it, with no core schema, like Better Auth's tables. A row
goes when its agent is disconnected, or its grant ends. Its person must be
in `people`.

| Table | One row per | Key |
|---|---|---|
| `people` | Person who has signed in: login, interests, when they joined, and when GitHub last showed their login | `github_id` |
| `projects` | Project: its current status, reason, and who set it and when, how it got in, with the policy quote, link, and tier for a policy listing, who added it and when, where its issues live, and its current settings version | `repo` |
| `project_settings` | Save of a project's settings: the whole settings, who saved them, and when | `repo`, `version` |
| `project_status_changes` | Change of a project's status: the status, the reason, who made it, and when | `id` |
| `tagged_issues` | Project's copy of an open tagged issue, as the last sync read it: title, labels, linked open PR with the ways the sync found it, and sync time | `project`, `issue_repo`, `number` |
| `issue_syncs` | Project the sync has started on: when its pass in progress started, when its last whole pass finished, when a maintainer last refreshed it, until when a run holds it, its code repo's main language, why GitHub delists it, if it does, and when the sync last read its repos | `project` |
| `claims` | Claim, mirrored from its issue room: issue, project, claimant, login when they claimed, agent, own-project flag, start commit, token estimate, state, times, release reason, PR, and the room's revision | `id` |
| `prs` | PR opened for a claim: repo, number, link, state, and when it opened, merged, and closed | `claim_id` |
| `submissions` | Claim's submitted work: the repo and branch it is on, the latest submit's commit, paths, title, summary, notes on what was checked, agent, model, lines added and removed, why it waits for the donor, and when | `claim_id` |
| `donor_sessions` | Donor session: harness, budget, start time, issues claimed, and the queue of picks | `id` |
| `donor_blocks` | Blocked donor: reason, admin, and time | `github_id` |
| `cla_confirmations` | Donor's confirmation that they signed a project's CLA: the link, and when | `github_id`, `project` |
| `do_not_list` | Repo whose maintainers asked to be removed: note, admin, and time | `repo` |
| `crawl_candidates` | Crawler find: repo facts, policy, suggested settings and tags, the line behind each suggestion, the sentences in its docs that name AI, status, and the admin's decision | `id` |
| `crawl_seeds` | Repo an admin added to the crawler's seed list: who added it and when, and when the crawler's cron job handled it and what it did | `repo` |
| `crawl_passes` | Pass of the crawler's search over the pool: when it started, the push date it looks after, the pool's size, the band and page it reads next, how many repos it queued, and when it finished | `started_at` |

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
  budgets, suggested settings, suggested tags, and a find's source lines. A PR is three columns,
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
  eligible, and the sync leaves it out, so no cached issue has one. The
  server checks GitHub again before it suggests or claims an issue, which
  catches an assignee added since the last sync.
- **`tagged_issues.linked_pr_found_by`** came with migration
  `0004_issue_sync.sql`, which also makes `issue_syncs`. It is a JSON list,
  null with no linked PR.
- **Migration `0005_donor_tools.sql`** adds `donor_sessions.queue`, a JSON
  list that starts empty, `issue_syncs.language`, and `cla_confirmations`.
  A confirmation's project has no foreign key, like a claim's, so it
  outlives a listing.
- **Migration `0006_delisting.sql`** adds `issue_syncs.delisted`, the
  reason GitHub delists the project or null, and
  `issue_syncs.repos_read_at`. Before it, a pause that named no one was the
  sync's delisting and hid the page, so the migration marks each project
  paused that way with its pause's reason. The sync's next read of its
  repos keeps the mark or takes it off.
- **Migration `0007_submissions.sql`** makes `submissions`, one row per
  claim, which each submit writes over, with a foreign key to the claim.
  `base` is the commit the files are read against, the start commit or a
  head named with `onto`. `diff_from` is the default branch's head at the
  latest submit, which the lines and the diff run from. `paths` is a JSON
  list. The lines added and
  removed are null when GitHub didn't say. The review reason is null for
  work whose PR was to open by itself. `my_work` reads the rows of a
  donor's claims awaiting review by key.
- **The crawler's tables** came with migration `0008_crawl.sql`: the seed
  list in `crawl_seeds`, owned by `src/db/seeds.ts`, the passes in
  `crawl_passes`, owned by `src/db/crawls.ts`, the index
  `crawl_candidates_by_repo`, and `crawl_candidates.sources`, JSON text
  that a find stored before it reads as an empty list, and
  `crawl_candidates.ai_sentences` and `more_ai_sentences`, the sentences
  that name AI with their paragraphs, which a find stored before has none
  of. A kept paragraph stored without `cutBefore` or `cutAfter` reads as
  uncut. `crawl_passes.open`
  is 1 or 0. A seed's `handled_at` and `outcome` are null until the cron
  job handles it, and set together. A pass keeps
  where it stands in its own row, and moves on only with a compare-and-set
  on the band and page it read, so two runs never both move it.
  `crawlerSkips` in `src/db/candidates.ts` asks the do-not-list, the
  projects, and the crawl candidates about any number of repos in one
  query.

### Who sees what

The spec says everything the site shows is public GitHub data or the public
live feed. It says crawl results stay in the deployment's database, and only
listed projects and their policy quotes are public, so `crawl_candidates`,
`crawl_seeds`, and `crawl_passes` stay private, a rejection's reason
included. The crawler keeps no verdict on a repo it doesn't propose. Its log
names the repos it proposed, a repo it couldn't read whole or GitHub failed
on, with no verdict on it, and a find it couldn't write. The reason an admin gives for
rejecting a registration reaches the maintainer's agent, and so does the
reason a removed project is rejected with. The note an admin keeps with a
do-not-list entry reaches no one else.

These columns are not public GitHub data, and the spec says nothing more
about who sees them: `people.interests`, `donor_sessions.budget`,
`donor_sessions.queue`, `cla_confirmations`, `donor_blocks.reason`, and
`do_not_list.reason`.

A submission's branch and commit are public on GitHub once they land. Its
title, summary, and notes on what was checked go into the PR when it opens,
with keys and tokens replaced before they are stored. Until then only the
donor's `my_work` shows them.

Better Auth's tables are for signing in, and no page shows them. The
`session.user_agent` column keeps the browser's user agent string, as Better
Auth does by default.

### Better Auth's tables

Migration `0002_sign_in.sql` makes them, with the tables and columns Better
Auth 1.7.6's CLI generates for SQLite, renamed to snake_case in
`src/auth/auth.ts`. Better Auth reads and writes them, and no module in
`src/db/` does.

| Table | One row per | Key |
|---|---|---|
| `user` | Person who has signed in on the site: their login as the name, their avatar, and a placeholder email | `id` |
| `session` | Signed-in browser: its token, the user, and when it ends | `id` |
| `account` | User's GitHub account: the numeric GitHub ID in `account_id`, the token from their last sign-in, encrypted, and its scope | `id` |
| `verification` | Sign-in in progress: its state, PKCE verifier, and where to go after | `id` |

They differ from the tables above where Better Auth needs it. Times are ISO
8601 text and true or false is 1 or 0, the way Better Auth writes them to
SQLite. The core schemas don't check the rows. Better Auth checks at start
that the tables have every column it expects. The tables are STRICT, like
the others. A session and a GitHub account go when their user goes.

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

The issue room numbers each version of a claim it saves, and gives every
change a higher number than the last, with a counter kept beside the claim
in its own storage. It saves each change with its number, and saves again
with the same number when a save may not have landed. What a stale save does
is under [the claims table](how-it-works.md#claims). The room never calls
`addPr`. The code that opens the PR records it.

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
| `projects_by_status` | The list of approved projects and the admin queue of pending ones, oldest first, and the paused and approved projects the sync checks |
| `projects_by_issue_repo` | The projects whose issues live in a repo, for a claim or a sync, and the copies of an issue the sync checks before a room forgets its PR |
| `project_status_changes_by_repo` | A project's status changes, newest first, and its latest, which names a registration in the admin queue |
| `claims_by_issue` | An issue's lanes, its slots, how many times it was claimed, and the tough badge |
| `claims_by_person` | One person's claims, newest first: `my_work`, the claims `start_session` offers to resume, a donor's open PRs by project, their page, and their leaderboard row |
| `claims_by_project` | One project's claims: its page's claims working now, merged PRs, and top helpers, its claims working now for `project_status`, and, in a time range, its row on the leaderboard by project |
| `prs_by_number` | A PR's claim, and one claim per PR |
| `prs_open` | The open PRs the PR job follows, oldest first, and whether a PR the sync saw is a claim's still open |
| `prs_by_opened` | PRs opened in a time range, like this week |
| `prs_by_closed` | PRs merged or closed in a time range, like this week |
| `donor_sessions_by_person` | A donor's last session, for what merged since |
| `crawl_candidates_waiting` | One waiting candidate per repo |
| `crawl_candidates_by_status` | The admin queue's crawler finds, oldest first |
| `crawl_candidates_by_repo` | Whether the crawler proposed a repo before, whatever the admin decided, which it asks for every repo it reads |
| `session_by_user` | A person's sessions, which signing out ends |
| `account_by_user` | A user's GitHub account, which every signed-in page view reads to find who they are |
| `account_by_provider` | The user for a GitHub account at sign-in, and one user per GitHub account |
| `verification_by_identifier` | A sign-in in progress, by the state GitHub sends back |
| `connected_agents_by_person` | A person's agents on `/me`, the earlier connections a new sign-in from the same client replaces, and a person's connections whose grants ended |

A merged PR always has a close time, as on GitHub, and only `closed_at` is
indexed. So merged PRs this week filter on `closed_at` with
`state = 'merged'`, which reads `prs_by_closed`. Filtering on `merged_at`
uses no index, so it reads every PR or every claim, depending on the query.
Merge rate reads the same index.

Some views have no index of their own. Issues worked per person this week
scans every claim. The all-time views scan `claims` or `prs` and look up the
other by key, and hiding blocked donors looks up `donor_blocks` by key.
Hiding what the sync delisted looks up `issue_syncs` by key. Hiding what
the do-not-list covers looks up `do_not_list` by key, and the
projects whose issues live in each repo through `projects_by_issue_repo`.

### Migrations

Migrations live in `apps/web/migrations/`, Wrangler's default folder,
numbered in order. `pnpm dev` runs `apps/web/scripts/migrate-local.mjs`
before it starts Vite. The script runs `wrangler d1 migrations apply DB
--local` with no input attached. Wrangler asks before it applies a migration
only when both its input and output are a terminal, so it applies new ones
without asking, whether `pnpm dev` runs from the root, where pnpm runs the
GitHub fake beside it, or in `apps/web`. It needs no network and no account.
Playwright's web server runs it too, before it builds the app, with
`--fresh` and `LOCAL_STATE_DIR`, which [Tests](#tests) describes. The database
tests apply the migrations in their setup, and a deploy applies
them to the environment's database before the Worker goes up, as
[Deploys](#deploys) describes. A schema change is a new migration. A
migration that has run on a deployed database never changes.

## The issue room

`IssueRoom` in `apps/web/src/rooms/issue-room.ts` is a Durable Object, one
per issue, that holds the issue's claims. Its rules are in
[how-it-works.md](how-it-works.md#the-issue-room).
`issueRoom(namespace, issue)` gets the room with `getByName`, named for the
issue in lower case. A claim's issue is checked by comparing the room's own
ID with `idFromName` of that issue in lower case. Cloudflare's
[DurableObjectId docs](https://developers.cloudflare.com/durable-objects/api/id/)
say `ctx.id.name` is set for an object reached with `getByName`, but it is
undefined when the ID came through `idFromString`, and for an alarm set
before 2026-03-15. The ID comparison holds either way.

**Its interface** is RPC methods on the stub, for the MCP tools to call:
`claim`, `postUpdate`, `submit`, `openPr`, `release`, `prOpened`, `prClosed`,
`snapshot`, and `history`, and `glance` for the
[issue page](#the-issue-page). `fetch` takes a WebSocket upgrade for a watcher,
with `?since=<event ID>`. Who is asking comes in as a numeric GitHub ID. A
refusal comes back as `{ ok: false, refusal }` with a code from core, a
malformed argument included. The runtime reports an error thrown in a
Durable Object as uncaught, even when the caller catches it, and Vitest
fails a run that has one, so the methods throw only for a bug.

**How it is the lock.** A Durable Object runs one call at a time until the
call awaits something outside its own storage. SQLite calls in a Durable
Object are synchronous. So each method reads the clock, applies the timers
that are due, checks, and writes, with no await in between. Only then does
it save to D1 and set the alarm, which do await. A claim that arrives while
another awaits D1 sees the first one's writes. A test sends four claims at
once to a 3-slot issue. With an await put between the count and the insert,
it fails.

**What it stores,** in its own SQLite:

| Table | One row per |
|---|---|
| `facts` | Fact about the room: `issue`, the issue it holds, as the first claim spelled it, and `watchers_retry_at`, when to try again a send to the watchers that D1 kept from going out |
| `claims` | Claim, as JSON, with its revision, its last post time for the 10-second rule, and where its save to D1 stands: the highest revision D1 is known to hold, the failed tries since the last save that landed, when the first of them was, when the last try started, the time before which no try is made, until when a call's try is out, and the revision the room gave up at |
| `issue_prs` | Open PR linked to the issue |
| `events` | Feed event, as JSON, in the order made. A watcher resumes by an event's ID. |
| `outbox` | Event not yet sent to the feed queue, by its place in `events`: the message to send, the failed tries, and the time before which no try is made |

The tables are made with `CREATE TABLE IF NOT EXISTS` when the object starts.
A later change to them needs a step that moves the rows it has. So does a
change to `claimRecordSchema` or `feedEventSchema`: the room checks every
stored claim and event against them when it reads one, so a new required
field would make every room that holds an older row throw, its alarm
included. Such a change needs a step that rewrites the stored rows first.

**Timers.** One alarm per room, set again at the end of every call, when a
send to the feed queue ends, and when D1 keeps a send to the watchers from
going out. The alarm runs the same steps as a call: apply the due timers,
then send and save what is due. When it is set for, and what the timers do,
is under
[the issue room's timers](how-it-works.md#the-issue-room).

**Saving to D1.** After its writes, each call lists the claims whose save
is due, and tries each with `saveClaim`, one at a time. It marks the
revision saved when the save lands or D1 calls it stale. Before the first
try, it moves the alarm to a minute ahead, unless the alarm is sooner, so a
call that dies mid-save leaves the room an alarm. Before each await, it
records the try's time and marks the try out for a minute, so a second call
leaves the claim alone while the first call's try is out, and a try whose
call died is due again a minute later. A failed try sets the next-try time
from the count of failed tries. A given-up save's next-try time is
`Number.MAX_SAFE_INTEGER`. A change to a claim, and a save that lands, move
waiting next-try times to at most a minute after the last try, in one
statement each. Claims a landing save made due are left for the alarm that
`schedule` sets at the end of the call. The retry and give-up rules are
under [Saving to the database](how-it-works.md#the-issue-room).

A test can't make two calls through the stub overlap at the D1 await on
purpose, because a failed save answers too fast. The test for the guard
calls `snapshot` twice at once inside the room with `runInDurableObject`,
which overlaps them at the first await, as the runtime does when D1 is
slow. `issue-room-crash.test.ts` swaps the D1 binding on the running room
for one whose queries never answer, then aborts the room with
`abortAllDurableObjects`, to check that a call that dies mid-save leaves an
alarm behind.

**Sending to the feed queue.** `emit` stores each event with a row in
`outbox` holding its `FeedMessage`, in the same step as the change. At the
end of the call, `sendDue` takes the rows at the front of `outbox` whose
send is due, up to the first that isn't, and marks them as out for a
minute, before any await, so another call leaves them alone. It sends them
with `sendBatch`, 50 to a batch, without the call's answer waiting. A batch
that lands is deleted from `outbox`. When one is refused, it and every row
after it get the same next try, from the failed tries of its first row, and
the send stops, so no event reaches the queue ahead of an earlier one. Rows
that came due during a send go out in the same loop. The `schedule` at the
end of the call counts the first row's next try, which is a minute ahead
for a row that is out, so a send whose call dies, or that never answers, is
tried again by the alarm. When the send ends, it calls `schedule` again. The
queue may then get an event twice, which the feeds ignore.

**Watchers** use the hibernation API, through `src/rooms/watchers.ts`, as
[The live feeds](#the-live-feeds) describes. What that means for a watcher
is under [Watchers](how-it-works.md#the-issue-room). The claimant of each
event, which the block check needs, comes from joining `events` to
`claims` on the event's claim ID. When D1 can't say who is blocked, the
room writes `watchers_retry_at`, a minute ahead, which `schedule` counts.
Only a send that leaves every watcher at the last event stored deletes it,
so a slow send that read its events before a newer one was stored leaves
the retry for the newer one in place. Each send moves a waiting
`watchers_retry_at` a minute ahead before it asks D1, so while D1 is slow
the alarm doesn't fire again and again.

**IDs.** Claim IDs are `c_` and event IDs `e_`, each followed by 20
URL-safe characters, made the same way as session IDs.

**Not here yet.** The PR job records when a claim's PR merged or closed, and
tells the room, which forgets it. The room keeps no state of its own for
that, so it doesn't refuse with `pr_closed`, and makes no `pr_merged` or
`pr_closed` event.

## The live feeds

The rules are in [how-it-works.md](how-it-works.md#live-feeds), and the
streams' in [Text streams](how-it-works.md#text-streams).

| File | What it does |
|---|---|
| `src/rooms/feed.ts` | `Feed`, the Durable Object for every feed, and `homeFeed`, `repoFeed`, and `personFeed`, which name them |
| `src/rooms/watchers.ts` | Opening a watcher's socket and sending new events to watchers, with the block check, for rooms and feeds alike |
| `src/feed/queue.ts` | The feed queue's consumer |
| `src/feed/streams.ts` | The text streams, and the live sockets pages open on them |
| `src/feed/format.ts` | The two line formats |
| `src/feed/follow.ts` | Following a live socket from a browser, with its reconnects, for pages and the views MCP Apps hosts show |
| `src/feed/useLiveFeed.ts` | The page's side of a live socket, as a React hook around `followFeed` |

- **One class, three kinds of feed.** `getByName` names each: `home`,
  `repo:` and the project's code repo in lower case, and `person:` and the
  numeric GitHub ID. A login can change hands, so no feed is named by one.
- **What a feed stores,** in its own SQLite: `events`, each event as JSON
  with its claimant's GitHub ID, in the order it arrived, and `seen`, the
  ID of each event it got, with the time. `deliver` inserts into `seen`
  first, and an insert that changes nothing marks a copy. It then drops the
  events past the newest 1,000, and the `seen` rows older than a week whose
  event it no longer keeps. A feed reads its rows back with the core schema,
  so the rule under [The issue room](#the-issue-room) about changing
  `feedEventSchema` covers feeds too.
- **Day counts.** A feed also keeps `day_counts`: for each UTC day and
  claimant, how many events it stored. `deliver` writes it in the same step
  as the event, and prunes it with the events. What it counts, and for how
  long, is under [Live feeds](how-it-works.md#live-feeds). The events
  themselves are capped at 1,000, so a count over them would stop at 1,000
  on a busy day. Keeping the claimant lets the block check leave a blocked
  donor's events out of a count, and lifting the block brings them back.
- **A glance for a page.** `glance({ count, day })` gives a page the newest
  events a watcher may see and the day's count, with the same block check a
  new watcher gets. When D1 can't say who is blocked, it answers null. The
  runtime reports an error thrown in a Durable Object as uncaught, even when
  the caller catches it, so it throws only for a bug.
- **The queue message** is core's `feedMessageSchema`: the event, the
  claimant's GitHub ID, and the project's code repo. The event carries
  neither of those, and adding them to `feedEventSchema` would need every
  room's stored events rewritten. The consumer checks each message with the
  schema, groups the batch by feed, and calls each feed's `deliver` once,
  all at the same time. It acknowledges each message whose three feeds took
  it, and asks for the rest again with `retry({ delaySeconds })`, the wait
  worked out from the message's `attempts`. A malformed message is asked for
  again at once, so its tries take it to the dead-letter queue, where it can
  be read.
- **The queue's settings** are in `wrangler.jsonc`, and the wait for each
  message the consumer asks for again is in `src/feed/queue.ts`. What they
  add up to is under [Live feeds](how-it-works.md#live-feeds). Two waits
  apply. `retry({ delaySeconds })` sets the wait for a message the consumer
  asks for again. The consumer's `retry_delay` in `wrangler.jsonc` is the
  wait when the batch fails as a whole, as when the consumer throws or runs
  out of time, and no message was asked for again. Cloudflare allows at most
  100 retries, and a wait of at most 24 hours. The deploy makes the queue
  with no retention setting, so it keeps messages for Cloudflare's default
  time, which is 4 days on paid plans and can be set up to 14. `max_retries`
  is set so the retries end well inside that time, since a message the
  queue deletes never reaches the dead-letter queue.
- **Order.** Queues promises no order, and with no `max_concurrency` set,
  batches can run at the same time. A feed stores events in the order they
  arrive, and a watcher resumes by the feed's own order, so a reader who
  reconnects misses nothing, even when the lines came out of order.
- **Watchers and the block check.** Each watcher's socket carries, as its
  attachment, the place of the last event it was sent, which survives
  hibernation. Events go out after the call that stored them, with an await
  for D1's `donor_blocks` and `do_not_list` in between, so calls can finish
  out of order. Each send reads the events after the lowest place among the
  sockets, asks D1 which of their claimants are blocked and which of their
  issues' repos the do-not-list covers, and sends each socket what it hasn't
  had, up to the last event it read before the await. An event stored
  during the await goes out with the send of the call that stored it. So
  each watcher gets each event once, in order. A send returns the lowest
  place a watcher is at once it is done, so a room can tell whether it
  reached the last event stored.
- **A new watcher's history.** The feed or room is told which donors are
  known to be blocked and which repos the do-not-list is known to cover,
  and reads only the events it will send: a feed with no `since` reads its
  newest 100 of the others, in one query. D1 is asked about any claimant or
  repo in them not yet asked about, and the read repeats until none is
  new. Then the socket is accepted, sent its history, and given its
  place, with no await in between, so no event falls between its history
  and the live ones.
- **When D1 can't say who is blocked,** a feed sets its alarm a minute
  ahead, and the alarm sends what is waiting. A feed has no other alarm.
  `deliver` also sends when every event it got was a copy, since the queue
  may be trying again after an earlier call stored the events and failed.
- **The block check runs as events go out.** So a block covers the history
  a feed already stores, and lifting it shows that history again.
  `blockedAmong` passes the IDs as one JSON array, since D1 binds at most
  100 values in a statement.
- **The do-not-list check runs beside it,** in `src/rooms/watchers.ts`,
  with `doNotListedAmong` in `src/db/do-not-list.ts`, which takes the repos
  as one JSON array the same way. An event names its issue, and a feed
  reads the issue's repo from the event's JSON in SQL, so no stored event
  needed rewriting. A repo on the list is covered whole, the issues of
  other projects that keep them there included, as the homepage's query
  and the issue page leave those projects out. The do-not-list names code
  repos, so the query also covers the issue repo of a project on the list,
  unless an approved or paused project off the list keeps its issues there
  too, since only those have claims. That keeps an approved or paused
  project's events on a shared issue repo shown. Judging each event by its
  claim's project would also hide a removed project's own events there, but
  would change how every feed and room reads its history, since they skip
  hidden repos in SQL. The `history()` RPC
  of a room and of a feed leaves blocked donors out too, and throws when D1
  can't say who they are.
  Tests read what is stored straight from the object's SQLite.
- **The Worker holds each stream.** It connects to the feed or room over the
  WebSocket a page uses, accepts it, and keeps each message it gets as a
  line, after checking it with `feedEventSchema`. The response body is a
  `ReadableStream` that gives the reader the oldest waiting line each time
  it asks. So the Durable Object can hibernate while the stream is open, and
  the Worker spends CPU only on the lines. A Worker that answers HTTP has no
  time limit while its client is connected, but Cloudflare gives it 30
  seconds to finish when the runtime is updated, which a reader sees as the
  stream ending early.
- **Ending a stream.** A timer ends it an hour after it opened, and a line
  that comes after the hour ends it too, which a test can reach with a fake
  `Date`. The Worker ends it when the feed closes the socket, when the body
  is cancelled, and when a new line finds the oldest waiting over a minute.
  Ending a stream closes the socket to the feed, which answers the close.
  The stream closes once the reader has taken every line. A stalled reader
  is cut off with an error, and so is one that stalls before it takes the
  rest, a minute later.
- **When the reader goes away.** The runtime is meant to cancel the body,
  which ends the stream. workerd since 1.20260619.1 doesn't, as
  [workerd issue 6832](https://github.com/cloudflare/workerd/issues/6832)
  reports, and the runtime the unit tests use shows the same through
  `exports.default.fetch`. Until that is fixed, the Worker learns a reader
  left from the minute rule, once a line has waited that long and another
  comes, or at the hour. The
  `enable_request_signal` compatibility flag would tell it at once. It is
  not on. It applies to every route of the Worker, and workerd calls it
  still experimental with no date to turn it on by default, though
  `compatibility-date.capnp` doesn't mark it `$experimental`, so a deploy
  would take it.
- **What a stream costs,** for the security review in
  [#34](https://github.com/meanwhileso/goodfirsttoken/issues/34), which takes
  stream rate limits.
  Each open stream holds a Worker request and a hibernating WebSocket on a
  feed or room, for up to an hour. Opening one reads D1 to find its feed or
  room: once for a person or a project, and for an issue, the reads
  `findIssue` makes, under [The issue page](#the-issue-page). Then twice for
  each round of the block check, once for blocked donors and once for the
  do-not-list, at the same time. It
  sends at most 100 events from a feed with no `since`, at most 1,000 with
  one, and an issue room's whole history. Each line costs the feed or room
  two D1 reads per batch it sends, shared by its watchers, and each stream a
  schema check. A stalled reader holds up to a minute of lines in memory,
  and a reader that went away holds its socket until the minute rule or the
  hour ends it. Nothing limits how many streams a client opens.
  A live socket costs the same to open, then holds only a hibernating socket
  on the feed or room, for as long as the page is open, with no hour limit.
  Every homepage view opens one on the homepage's feed, so that one object
  sends every event to every open homepage. It also takes one `glance` per
  homepage view. Every project page view opens one on its project's feed,
  and takes one `glance`, and every issue page view opens one on its
  issue's room. Each message a page sends on its socket wakes the feed or
  room from hibernation, which Cloudflare bills, though the feed ignores
  the message.
  Nothing limits how many sockets a client opens, or how many messages it
  sends on one, yet. #34 takes those limits.
- **Live sockets.** A page opens a WebSocket on a stream's `.ndjson` URL.
  `handleStream` sees the upgrade, finds the feed or room and checks `since`
  the same way as for a stream, and forwards the upgrade to it. The Worker
  answers with the `101` and the socket the feed or room accepted, so the
  browser holds the feed's own hibernating socket, and no Worker request
  stays open for it. That is why the socket has no hour limit, and why the
  block check is the one every watcher gets. The socket lives on the
  stream's own URL, so each feed has one address, one resolver, and one set
  of `404`s, for people, programs, and pages alike. The homepage, a
  project's page, and the issue page open theirs with `useLiveFeed`, and
  person pages and `/live` (#26) can too.
- **`useLiveFeed(path, since, onEvent)`** opens the socket from the page,
  hands each new event to the page once, and reconnects after a drop with
  the last event's ID, backing off as
  [Live sockets](how-it-works.md#live-sockets) says. It closes the socket
  when the component unmounts. It checks each message with core's
  `feedEventSchema`, as the streams do, and skips one that isn't a feed
  event. The socket, the reconnects, and the check for an event seen twice
  are `followFeed` in `src/feed/follow.ts`, which imports nothing that runs,
  so the views MCP Apps hosts show follow an issue's socket with it too.
- **Which streams exist.** A person's stream needs the person in `people`,
  a repo's the project in `projects`, and an issue's a claim in `claims` or
  the issue in `tagged_issues`, which `findIssue` in `src/issue/find.ts`
  checks for the stream and the issue page alike. Connecting to a feed or
  room that has never been used makes it, with storage, so a stream for
  anything else would let anyone make Durable Objects without end.
- **Compression.** Cloudflare compresses `text/plain` for a browser that
  accepts it, which would hold lines back until a chunk fills.
  `Cache-Control: no-transform` turns that off.
- **The local server holds a stream's headers** until its first line, in
  `vite preview` and `pnpm dev`. A `HEAD` answers at once. The Workers
  runtime itself hands back the answer before any line, as the unit tests
  show.

## The homepage

The rules are in [how-it-works.md](how-it-works.md#the-homepage).

| File | What it does |
|---|---|
| `src/routes/index.tsx` | The page, built from the components in `src/components/`, and the live state of its wall and token field |
| `src/home/data.ts` | `getHome`, the server function the route's loader calls |
| `src/home/load.ts` | `loadHome`, which reads what the page shows, on the server only |
| `src/home/live.ts` | The wall's lines and the token field's squares, for the server and the page alike |
| `src/project/ProjectRow.tsx` | A project asking for help as a row, which the projects list shows too |
| `src/styles/home-page.css` | The page's layout |
| `src/styles/project-rows.css` | The rows' layout, which the projects list links too |

- **What the page reads.** `loadHome` reads its three parts at the same
  time: a `glance` at the homepage's feed, `topMergers` in `src/db/prs.ts`,
  and `listProjectsAskingForHelp` in `src/db/projects.ts`. A part that
  throws is null, and the page says it can't be read, so the prompt always
  shows. Each view costs one call to the homepage's feed, which reads D1 for
  its block check when it has events, and two D1 queries. Nothing caches
  them yet.
- **Merged this week** filters `prs` on `closed_at` with `state = 'merged'`,
  which reads `prs_by_closed`, and joins each PR to its claim and the
  claimant's row in `people`. It takes the agent of each person's latest
  merge from SQLite's bare column with `MAX()`: in a query with one `MAX()`,
  a column that isn't aggregated comes from the row that has the maximum.
  `startOfWeek` in the same file gives the Monday.
- **Asking for help** counts each approved project's waiting issues in the
  same query, with `json_each` over the issue's labels and the project's
  current settings. The rule for an issue waiting is SQL in
  `src/db/waiting.ts`, which every part of the site that asks follows.
  SQLite's `lower()` folds only ASCII letters, so two labels that differ in
  the case of other letters don't match there. The
  claims that hold a slot come from the claims mirror, through
  `claims_by_issue`. The query applies the 24 hours and the 7 days from
  core's `CLAIM_LIFETIME_MS` and `REVIEW_WINDOW_MS` itself, as `holdsSlot`
  does, so a claim past its deadline frees its slot before the room's timer
  saves it. `COUNT(*) OVER ()` gives the total before the limit.
- **The live parts.** The loader gives the wall's newest events and the
  field's squares as the server lit them. The page then opens `/live.ndjson`
  with `useLiveFeed`, starting after the newest event it shows, and lights
  squares with the same function the server used. The squares come from a
  hash of each event's ID, so the page and the server agree on them with
  nothing stored.
- **The prompt's site** comes from `siteOrigin` in `src/auth/settings.ts`,
  the primary domain or the request's origin, so no deployment domain is in
  the code.
- **The launch video and its poster** are imported with `?url`, so they come
  from [the static host](#the-static-host). How the page loads them is under
  [The homepage](how-it-works.md#the-homepage).
- **The setup's commands** are listed in
  [how-it-works.md](how-it-works.md#the-homepage). The Claude Code install
  command names the plugin with its marketplace, Claude Code's form for a
  plugin from a given marketplace, and both names come from
  `.claude-plugin/marketplace.json`. The setup gives no command for the MCP
  server. `/start.md` (#21) will.

## The issue page

The rules are in [how-it-works.md](how-it-works.md#the-issue-page).

| File | What it does |
|---|---|
| `src/routes/$owner.$repo.issues.$number.tsx` | The page, built from the components in `src/components/`, with its lanes, slot panes, and timeline |
| `src/issue/data.ts` | `getIssuePage`, the server function the route's loader calls |
| `src/issue/load.ts` | `loadIssue`, which reads what the page shows, on the server only |
| `src/issue/find.ts` | `findIssue`, which says whether an issue is on the site, for the page and the issue's stream, with each project's copy judged, and `followedCopy`, the copy the page follows, for the page and `claim_issue` |
| `src/issue/path.ts` | `issueFromPath`, the issue a page's path names, for the server and the 404 page |
| `src/issue/view.ts` | The lanes, slots, timeline, and open PRs, folded from the room's events, for the server and the page alike |
| `src/styles/issue-page.css` | The page's layout |

- **The room is the source.** `loadIssue` reads the claims, their lines,
  the timeline, and the open PRs from the issue's room, in one call,
  `glance`. The room applies any pause or expiry that is due, reads the
  claims, the open PRs, and the events with no await between them, then
  leaves out blocked donors' events, and answers null when D1 can't say who
  they are. So a PR that opens while the page loads is in its open PRs
  exactly when its event is in the history, and the socket, which starts
  after the last event, brings it otherwise. A test holds the block check
  while a PR opens, to show it. The claims table in D1 would do for the
  claims, but it can lag behind a save that waits for a retry, it holds no
  lines, and it has no PR someone opened outside Good First Token. And the
  page's socket resumes from the room's own event IDs, so the history the
  page loads with and the events after it come from one place.
- **One fold for the server and the page.** `foldEvents` in
  `src/issue/view.ts` turns the room's events into the lanes and the
  timeline. The server folds the history, and the page folds in each event
  from the socket with `applyEvent`, so a page that follows the room and one
  that loads later agree. A lane's state follows the events, the same moves
  `nextClaimState` makes. The glance adds what the events can't say: the
  open PRs, as repos and numbers, and the claims that have no event the page
  may see.
- **Blocked donors.** Their events are left out of the history, so they have
  no lane. The glance still holds their claims, so the page counts the ones
  holding a slot, and each claim, without naming them. When the room's D1
  can't say who is blocked, the glance is null and the page answers `503`.
  Tests make the room's block check throw, and hold it while a PR opens,
  through `loadIssue`.
- **Which issues have a page** is the rule for which issues have a stream,
  in one place: `findIssue` in `src/issue/find.ts`, which `sourceFor` in
  `src/feed/streams.ts` calls too. It reads the claims table and the
  projects that keep their issues in the repo, at the same time, then each
  one's cached copy. The page uses the claims and copies it found, for the
  project, the title, and the linked PR. Tests check that an issue with
  neither gets a `404` from the page and from the stream, and that no room
  is made. The one difference is the path, under The site's own paths.
- **Whether it takes claims** follows the homepage's rule for an issue
  waiting for an agent, the SQL in `src/db/waiting.ts`. `findIssue` reads
  each project's copy with `listJudgedCopies` in `src/db/issues.ts`, which
  judges it with `CLOSED_BECAUSE` there, less the open PRs and the free
  slot, which the page follows live: a project asking for help, so
  approved and off the do-not-list, and then a cached copy with one of its
  tags and none of its excluded ones. The project comes first, so the page
  says the project isn't taking claims whatever the copy's labels are.
  With no copy, `isAskingForHelp` in `src/db/projects.ts` says the same of
  the project the latest claim went to. `followedCopy` in
  `src/issue/find.ts` then picks the copy the page follows, as how-it-works
  says, checking the slots taken against each copy's own claims per issue.
  That copy's linked PR joins the room's open PRs. `claim_issue` makes the
  same pick.
- **The site's own paths.** A project's page is at `/<owner>/<repo>`, with
  its issues' pages and its streams under it, so a path the site keeps for
  itself could name a repo. `src/issue/path.ts` holds one rule for the
  project page and the issue page: an owner whose paths belong to the site
  has neither, and both answer `404` for it, through `repoFromPath` and
  `issueFromPath`. Each of the site's paths, and whether it can meet a
  project's:
  - `/auth/...` and `/mcp/...` go to sign-in and the MCP server in
    `src/server.ts` before any page or stream, whatever follows. The OAuth
    library matches `/mcp` as a prefix, so `/mcp/<repo>` gets its `401`.
    `auth` and `mcp` are reserved.
  - `/oauth/token` and `/oauth/register` go to the OAuth library, and
    `/oauth/authorize` is the page where a person approves an agent. Only
    those three repo names meet, but `oauth` is reserved whole, like the
    others, so one rule covers every owner.
  - `/admin` is the admin pages, where their forms post too. It has one
    part, so no project page can be it, and nothing under it is the
    site's. `admin` is reserved all the same, like every owner named for a
    page of the site's own.
  - `/dev/seed` and `/dev/work` are routes of their own, which TanStack
    Router matches ahead of `/$owner/$repo/`. They exist in every
    environment, and answer `404` outside development, so `dev` is
    reserved too. Sending `/mcp/<anything>` to the site ahead of the OAuth
    library would still leave `auth`, `oauth`, and `dev` to reserve, so the
    rule reserves owners.
  - `/_serverFn/...`, where TanStack Start answers server functions, and
    `/.well-known/...`, where the OAuth library answers its metadata, can't
    name a repo: no GitHub login starts with `_` or `.`. Nor can
    `/@<user>/...`, since no login has `@`.
  - `/`, `/projects`, `/design`, `/me`, `/sign-in`, `/healthz`,
    `/live.txt`, and `/live.ndjson` have one part, like `/admin`, and a project's page
    two. A path under one of them, like `/projects/<name>`, is a project's
    page, since the site has no route there.
  - `src/server.ts` sends every path shaped like a stream to
    `src/feed/streams.ts` first: `/<owner>/<repo>/live.txt` and its issue's
    have more parts than a page. A repo named `live.txt` has its page at
    `/<owner>/live.txt`, which no stream's pattern matches.
  - `/assets/<file>`, when a deployment serves its own built files, is
    answered by Cloudflare before the Worker when the file exists. Only a
    repo named exactly like a built file, whose name carries a hash of its
    content, would lose its page, so `assets` isn't reserved.

  A stream doesn't follow the rule. One on an `/oauth/...` or `/dev/...`
  path answers as any other, and one on `/mcp/...` gets the MCP server's
  `401`.
- **Logins now.** Events carry the login a claimant had when they claimed.
  Each lane, and the timeline, shows the login in `people` for the claim's
  GitHub ID, since a renamed login can later belong to someone else.
- **PR links.** A PR reaches the page as its repo and number only, and
  `prUrl` in `src/issue/view.ts` builds its link to GitHub, whether it came
  from the room, the cache's linked PR, or a `pr_opened` event, whose text
  carries only `opened PR owner/name#57`. The link stored with a PR can be
  on any host, so it never reaches the page. The sync tells the room of the
  PR it saw linked, so while the project the page follows has no page, the
  room's PRs the page shows are its claims' own, by the PR each claim
  holds.
- **The status.** The loader throws TanStack Router's `notFound()` for an
  issue with no page, which renders the route's not-found component with
  `404`. When D1 or the room throws, the server function names `503` in
  `x-gft-page-status`, the header the page on `/oauth/authorize` uses, and
  `src/server.ts` sets it.
- **The lanes are the page's own markup,** like the homepage's project rows.
  `/design` shows every component in `src/components/`, and a new sample
  there changes its screenshots, which have to come from CI's Playwright
  build. The page builds the lanes from `Chip`, `Slots`, `SlotRing`,
  `Prompt`, `Marker`, and `Rail`. In its prompts, `PromptPath` holds the
  claim command's `owner/repo#n` and the stream's URL: an inline block with
  a `<wbr>` after each slash between two names, so the path starts a new
  line whole when it fits there, and wraps after a slash when it doesn't.
  It is a part of the prompt, like `PromptAccent`, and `/design` doesn't
  show it.
- **What a view costs.** The reads `findIssue` makes. One for the project
  when the issue isn't cached, one for each person who claimed it, since the
  timeline names every claimant, and two or three for each project with a
  cached copy that is approved or paused, or for the project of the latest
  claim when none has a copy, as `hasPage` looks up the sync's mark in
  `issue_syncs` and the do-not-list for its repo and its issue repo, all at
  once. That one answer decides the breadcrumb, the cached copy, and
  whether the project takes claims.
  Then the room's glance, which reads its whole history and asks D1 which
  donors are blocked and whether the do-not-list covers the issue's repo,
  two queries at once, and a socket on the room for as long as the page is
  open. Each lane keeps its newest 20 lines, so the page carries at most
  that many per claim. Nothing caches any of it yet.

## The project pages

The rules are in [how-it-works.md](how-it-works.md#the-projects-list),
under The projects list and The project page.

| File | What it does |
|---|---|
| `src/routes/projects.tsx` | The projects list, with its filter and search |
| `src/routes/$owner.$repo.index.tsx` | A project's page, built from the components in `src/components/`, with its issue rows, merged PRs, rules, and live wall |
| `src/project/data.ts` | `getProjectsList` and `getProjectPage`, the server functions the routes' loaders call |
| `src/project/load.ts` | `loadProjectsList` and `loadProject`, which read what the pages show, on the server only |
| `src/project/list.ts` | The list's filter and search |
| `src/project/rules.ts` | A project's settings as split badges |
| `src/project/shown.ts` | `hasPage`, which projects have a page by their status, the sync's mark, and the do-not-list entries of their repo and issue repo, for a project's page, and on its issues' pages for the breadcrumb, the cached copy, and whether the project takes claims |
| `src/project/ProjectRow.tsx` | A project as a row, which the homepage shows too |
| `src/db/waiting.ts` | The rule for an issue waiting for an agent, as SQL |
| `src/styles/projects-page.css`, `src/styles/project-page.css` | The pages' layout |

- **The list is the homepage's.** `loadProjectsList` calls
  `listProjectsAskingForHelp` with a limit of 1,000, so the list has the
  homepage's projects, order, and waiting counts, and adds how each got in
  from the project's record. The filter and the search run in the page
  over what it loaded, with `filterProjects` in `src/project/list.ts`.
  Their controls sit in a `fieldset` that is disabled in the server's
  render and enabled from the page's first render after hydration, so
  they look off until they work, and a test can wait for them.
- **One waiting rule.** `src/db/waiting.ts` holds the SQL for a project
  asking for help, `ASKING_FOR_HELP`, which reads the sync's mark with
  `DELISTED`, a cached copy that carries a tag, the slots its claims hold
  at a time, a claim's PR that is still open, the whole rule for an issue
  waiting for an agent, and why a copy takes no claims whatever its slots
  and PRs. Every query that asks uses it:
  - `listProjectsAskingForHelp` counts each project's copies that wait, for
    the homepage and the projects list.
  - `listProjectIssues` in `src/db/issues.ts` says for each copy of one
    project how many slots are taken, which claim's PR is open, and
    whether it takes claims, for its page.
  - `listWaitingIssues` in `src/db/projects.ts` lists the copies that take
    claims, for `suggest_issues`.
  - `listJudgedCopies` in `src/db/issues.ts` judges the copies of one issue,
    for its page and `claim_issue`, and `judgeLabels` there the labels an
    issue carries on GitHub now, for `suggest_issues` and `claim_issue`.
  - `doNotListedProjects` in `src/db/projects.ts` says which of a donor's
    claims are on a project on the do-not-list, with `ON_THE_DO_NOT_LIST`,
    the part of `ASKING_FOR_HELP` that reads the list, for `start_session`,
    `my_work`, and resuming with `claim_issue`. `delistedProjects` beside
    it says which the sync delisted, with the reason, through `DELISTED`,
    the part that reads the mark, for the same tools and for the refusal
    of a new claim.

  A test checks that the page's issues that take claims are the ones the
  homepage counts waiting and the ones `suggest_issues` starts from.
- **What the page reads.** `loadProject` reads the project, then asks
  `hasPage` in `src/project/shown.ts` whether it has a page, by its status,
  whether the sync delisted it, and whether its repo or its issue repo has
  an entry of its own on the do-not-list, as the homepage's query checks.
  For a project that could have a page, that agrees with
  `doNotListedAmong`, the rule the rooms and feeds hide events by, on its
  issue repo, since the project keeps its issues there and is off the
  list. `doNotListedAmong` reads every repo as an issue repo, so `hasPage`
  doesn't ask it about the code repo, where a project on the list that
  kept its issues there would take the page away. Who paused it doesn't
  count. The mark in
  `issue_syncs.delisted` hides what the site cached from the repos,
  whatever the status, and `DELISTED` in `src/db/waiting.ts` reads the same
  column for the lists and the claims, so the rule lives in that column
  alone. Then, at the same time, its
  tagged issues with `listProjectIssues`, the claims working now with
  `countWorkingClaims`, the merged PRs with `listMergedPrs`, the top
  helpers with `topHelpers`, the save of its current settings with
  `getSettingsSave`, and a `glance` at the project's feed. Then each
  person it names, by their login now. A failed read of the feed leaves
  the wall empty with a note, and any other failed read makes the page
  answer `503`, through `PAGE_STATUS_HEADER`, as the issue page does.
- **Merged work and top helpers** come from `claims` and `prs` in
  `src/db/prs.ts`. `topHelpers` and the homepage's `topMergers` share one
  ranking query and one filter for what shows, which leaves out blocked
  donors and PRs the do-not-list names. Only the scope differs: a time
  range read through `prs_by_closed`, or a project read through
  `claims_by_project`. `listMergedPrs` counts them all with
  `COUNT(*) OVER ()` as it takes the first 10. Only PRs from claims are in
  `prs`. The sync keeps a linked PR from anyone only while it is open, and
  the PR job reads only the PRs in `prs`, so a PR from outside Good First
  Token is never recorded as merged.
- **The live wall** is the homepage's `Wall`, fed by the project's feed:
  the page loads with a `glance` of 6 events, then opens
  `/<owner>/<repo>/live.ndjson` with `useLiveFeed`, starting after the
  newest line it shows, and puts each event on top with `toWallLine` from
  `src/home/live.ts`. The feed's `glance` leaves blocked donors' events
  out.
- **The route's file** is `$owner.$repo.index.tsx`, an index route. A file
  named `$owner.$repo.tsx` would make every issue page a child of it, with
  its loader run first.
- **The takeover link** goes to `/maintainers`, the page
  [brand/brief-website.md](../brand/brief-website.md) gives the job of
  saying how to take over a listing from an agent. A maintainer takes a
  listing over with `register_project`, under
  [Registering a project](how-it-works.md#registering-a-project).
- **What a view costs.** The list is one D1 query, the homepage's, which
  counts the waiting issues of every approved project. A project's page
  reads the project, then its row in `issue_syncs` and the do-not-list once
  or twice, by key, all at once. Then it makes six reads at once. Its
  tagged issues are one query, through the
  table's key, with each issue's claims through `claims_by_issue`. The
  claims working now, the merged PRs, and the top helpers are one query
  each, through
  `claims_by_project`, with each PR, person, block, and do-not-list entry
  by key. The save of its settings is one read by key. The `glance` at the
  project's feed asks D1 which of the donors in the events it reads are
  blocked and which of their repos the do-not-list covers, two queries at
  once, and reads again for as long as a round names donors or repos it
  hasn't asked about, so once when nothing is hidden, and never when the
  feed has no events. Then it reads `people` once or twice. So a view
  costs about twelve D1 queries, one call to a feed, and a socket on the
  feed for as long as the page is open.
  The three queries through `claims_by_project` read every claim the
  project ever had, since the index keys claims by project and claim time,
  and none of them is limited in time. The working claims are filtered by
  state after the index, and the merged PRs and top helpers look up each
  claim's PR. So the rows a view reads grow with the project's claim
  history, three times over. Nothing caches any of it yet.

## The sync

The tagged-issue sync and the PR job read GitHub on a schedule, with the
read-only service token. The rules are in
[how-it-works.md](how-it-works.md#tagged-issues), under Tagged issues and
[PRs](how-it-works.md#prs).

| File | What it does |
|---|---|
| `src/sync/github.ts` | `ServiceGitHub`, which makes a job's calls with the service token, asks GitHub what is left of the budget first, counts the calls, reads the rate limit after each, and stops the run. A search counts against the search budget. A stop for the budget carries when the budget starts over, which the crawler's consumer waits for |
| `src/sync/issues.ts` | The tagged-issue sync: one project's pass, the checks of the repos of the projects it reads no issues for, and the scheduled run over them all |
| `src/sync/prs.ts` | The PR job |
| `src/sync/scheduled.ts` | The crons, what each job may spend, the job each cron runs, and a maintainer's refresh |
| `src/db/syncs.ts` | The `issue_syncs` table, where each project's pass stands, when a maintainer last refreshed it, which run holds it, and whether the sync delisted it, with the projects a run checks |

- **Cron triggers.** `wrangler.jsonc` lists `*/15 * * * *` for the sync,
  `7,37 * * * *` for the PR job, and `52 * * * *` for the policy crawler's
  search, under [The policy crawler](#the-policy-crawler), so no two start
  in the same minute. The Worker's `scheduled` handler in `src/server.ts` hands the cron
  to `runScheduled`, which runs its job, and logs an error for a cron no job
  answers. The deploy copies the triggers as they are.
- **The service token** is the `GH_SERVICE_TOKEN` secret, a token that reads
  public data only, like a fine-grained personal access token for public
  repos with no permissions, as
  [self-hosting.md](self-hosting.md#the-token-for-reading-github) says. With
  none, no job reads anything, and the log names the secret. No person's
  token is ever used for these reads.
- **What a pass costs.** One REST call for the repo, one more for an issue
  repo apart from it, one for each 100 open issues under each tag, one
  GraphQL query for each 25 issues, and one REST call for each 100 events on
  each issue's timeline. The timelines are most of it: about one call for
  each tagged issue.
- **What a check costs.** A check of a project the sync reads no issues
  for, a paused one or an approved one it delisted, costs one REST call for
  its code repo, and one more for an issue repo apart from it. The first
  repo GitHub doesn't show ends the check, so a gone code repo costs one.
- **One list for each tag.** GitHub's issue list filter takes labels as a
  list separated by commas, and an issue has to carry every one. So each tag
  is a list of its own, with `assignee=none`, and the lists meet in code,
  which also leaves out pull requests and excluded tags. A tag with a comma in
  its name can't be listed this way.
- **One call at a time.** GitHub asks a client not to make concurrent
  requests for one user, or it may apply a secondary rate limit.
- **The budget.** GitHub counts a token's calls against its account, the
  budget [how-it-works.md](how-it-works.md#tagged-issues) gives under The
  budget, and says in the `x-ratelimit` headers of every answer how much is
  left and when it starts over. A run first reads `GET /rate_limit`, which
  GitHub counts against no budget, so it knows what is left before its
  first read. `ServiceGitHub` keeps the latest for each resource, `core` and
  `graphql`, and stops before a call when less is left than the job leaves:
  `ALLOWANCES` in `src/sync/scheduled.ts`. A budget whose hour is over counts
  as full again.
- **What stops a run.** A `429`. A `403` with nothing left, a `retry-after`,
  or a message that says it is a rate limit, since GitHub's docs say a
  secondary rate limit can come with neither header. A GraphQL error of type
  `RATE_LIMITED`, or whose message says it is a rate limit, which GitHub can
  send with status 200. A `401`, a `5xx`, a failed fetch, and an answer
  that isn't JSON. Any other refusal goes back to the code that made the
  call, which knows what a `404` means there. The PR job stops on any
  refusal of its query, and ends without an error.
- **Only GitHub's answers delist a project.** `GitHubError` keeps the
  `message` of GitHub's JSON error body apart, as `bodyMessage`, which is
  null when the body was anything else. A repo read delists a project only on
  a `404` whose body says `Not Found`, a `451` with a JSON body, or a repo
  with the fields GitHub sends that says it is private or archived. A
  `/rate_limit` answer without GitHub's budgets, or any other `404` or
  `451`, stops the run. So a proxy, or a `GH_API_URL` that isn't GitHub's
  API, never delists or pauses a project.
- **Calls in one run.** The caps in
  [how-it-works.md](how-it-works.md#tagged-issues), under The budget, count
  the `/rate_limit` read too. Four sync runs an hour at the sync's cap come
  to four fifths of the budget, all it spends before it stops. The checks
  come out of the sync's own cap, so a run still costs at most 1,000 calls:
  the `/rate_limit` read, then one or two for each project it checks, then
  its passes. `checkCalls` in the sync's `ALLOWANCES`, in
  `src/sync/scheduled.ts` with the other budget figures, starts no new
  check once the checks have made 100 calls, a tenth of the run, so the
  passes always get about nine tenths, and checks spend about 400 calls an
  hour at most.
  Each project is checked every run while they fit in 100 calls: 50 that
  keep their issues in a repo apart, or 100 that don't. Past that, each is
  checked every few runs, the one read longest ago first. The caps keep a
  run inside Cloudflare's limits, which
  [developers.cloudflare.com/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/)
  gave on 2026-09-27: 10,000 subrequests for one invocation on the Workers
  Paid plan, calls to D1, KV, and R2 included, and 30 seconds of CPU for a
  cron that runs more often than hourly, with 15 minutes of wall time. The
  Workers Free plan allows 50 subrequests and 10 ms of CPU, so a run there
  reads little. The sync hasn't been tried there.
- **Passes.** `issue_syncs` keeps each project's pass in progress, and when
  the last whole pass finished. A resumed
  run lists the tags again, which is cheap, and skips the issues whose copy
  was saved after the pass started. A new pass starts a millisecond after
  the last one finished at the earliest, so no issue from the last pass
  counts as read in the new one. Copies are dropped by key at the end of a
  pass, when the listing is whole.
- **One run holds a project.** Before a run reads a project, it sets
  `reading_until` in `issue_syncs` to 15 minutes ahead, the longest a
  scheduled run lasts, in a statement that sets it only when no other hold is
  left, and clears its own hold when it is done. A scheduled run leaves a
  project another run holds, and a refresh answers `busy`. A run that dies
  keeps its hold until the time runs out.
- **The rooms.** The sync calls an issue room's `prOpened` and `prClosed`
  only when the linked PR it keeps for the issue changes, so a room is made
  only for an issue that gets a linked PR. The new PR goes in before the old
  one comes out. The cache keeps the PR the room was last told, so a call
  that fails is made again on the next pass. The sync leaves `prClosed` to
  the PR job only for a claim's PR in the claim's own issue's room, found by
  joining `prs` to `claims`, since the PR job closes it there and nowhere
  else. The PR job calls `prClosed` before it writes the table, for the same
  reason.
- **Which PRs count** is under Linked PRs in
  [how-it-works.md](how-it-works.md#tagged-issues), and why is in
  [spec §6](specs/v1.md#6-issues-and-claims). GitHub gives a PR's base
  repo, where it is open, so a PR from a fork counts when it is aimed at the
  project. The read of each repo before a pass gives its `full_name` as
  GitHub has it now, which the pass adds to the names a PR's repo can match,
  so a rename doesn't drop the project's PRs.
- **The code repo's language.** The read of the code repo before a pass
  gives its `language`, which `setProjectLanguage` keeps in
  `issue_syncs.language` for ranking suggestions. It costs no call of its
  own.
- **Delisting** writes the mark first, `issue_syncs.delisted` with the
  reason, through `setDelisted` in `src/db/syncs.ts`, so the page is hidden
  even when the pause doesn't land. Then it pauses an approved project with
  `setProjectStatusFrom`, the compare-and-set #55 added, with `changed_by`
  null, which the maintainer's `pause_project` reads as a pause only an
  admin can lift. It tries three times, and stops as soon as the project
  isn't approved. A read that finds both repos public and open clears the
  mark, in the same statement that keeps `repos_read_at`. GitHub answers a
  REST call to a renamed or moved repo's old name with a redirect, which
  `fetch` follows.
- **The mark sits beside the status** of a paused project. Taking over a
  maintainer's pause would make it the admins' to lift, by `resumableBy`,
  add a status change the maintainer didn't make, and need an admin to
  bring the page back once the repo is public again. The mark changes
  nothing a person set, adds nothing to the status history, and comes off
  by itself. The approved case moved onto it too: `hasPage` no longer reads
  a pause with no person as hidden, so one column says whether what was
  cached shows. The pause of an approved project stays, since it keeps the
  status history and the admin's say over the claims. Neither writes a feed
  event, since only issue rooms make those.
- **Resuming** leaves the mark, so the gap between a resume and the next
  run shows nothing cached. Two paths resume a project, the maintainer's
  `pause_project` and the admin's `admin_pause_project`, and no site form
  pauses or resumes a project. Neither reads the repo for the mark: the maintainer's
  asks GitHub only for their role, with their own token, and the admin's
  asks nothing. The first check after a resume pauses the project again
  when the repo is still gone, or takes the mark off when it isn't. Only
  the service token sets or clears the mark, so no person's token is
  used on anyone else's behalf.
- **The checks** come first in a run, before the passes, from
  `listProjectsToCheck` in `src/db/syncs.ts`: every paused project and every
  approved one delisted, off the do-not-list, ordered by `repos_read_at`,
  never read first. A pass reads the repos of an approved project anyway,
  so an approved project that isn't delisted isn't checked. A refusal about
  one project skips its check, and the next run tries it again. A check
  holds no project, since it only reads the repos, sets the mark, and
  pauses through the compare-and-set.
- **The PR job** reads 50 PRs in one GraphQL query, each by its repo and
  number, so one point covers them.
- **A maintainer's refresh** is `project_status` with `refresh`. It runs
  inside the MCP call, so it gets few calls, under The budget in
  [how-it-works.md](how-it-works.md#tagged-issues). `takeRefresh` records
  the refresh and takes the hold in one statement, only when no refresh
  started in the last 10 minutes and no run holds the project, so two
  refreshes at once make one read. `issue_syncs.refreshed_at` counts only
  refreshes, so a scheduled run never makes a refresh wait.
- **The log.** Each run logs one line, with what it read, what is left of
  the budget, the projects another run held, how many projects it checked
  and which of them it delisted, and every open PR it found linked to the
  issues it read, each counted once for each issue, by the ways it was
  found. It counts the PRs in other repos apart.

### Open question 7: finding linked PRs

[Open question 7](specs/v1.md#open-questions) asks how reliably GitHub's
closing references and timeline cross-references find the PRs linked to an
issue, including PRs that mention it without closing it. This is what
building the sync showed, from GitHub's docs and the GitHub fake. It isn't
measured on real GitHub yet. The run logs are how to measure it.

- **Closing references** come from GraphQL's
  `Issue.closedByPullRequestsReferences`, which GitHub documents as the open
  pull requests referenced from the issue. It takes `includeClosedPrs`, and
  `userLinkedOnly` and `excludeUserLinked`, so it holds PRs someone linked by
  hand in the issue's Development box as well as PRs whose description
  closes the issue with a keyword. GitHub's docs say a keyword links only
  from a PR's description, and only on a PR aimed at its repo's default
  branch. A keyword in a commit message closes the issue when the commit
  merges, but links no PR. A keyword is read as the description is now:
  edit it out, and the PR is no longer linked. So closing references miss a
  PR that mentions the issue without a keyword, one aimed at another branch,
  one whose keyword is only in its commits, and a keyword with a typo.
- **Cross-references** come from the REST timeline's `cross-referenced`
  events, which the issue events API doesn't have. GitHub adds one when an
  issue or PR mentions the issue, so the sync keeps only those whose source
  is a PR. Each event carries its source issue, with its state and, for a
  PR, when it merged, so one read of the timeline says which PRs are open.
  The timeline is paged, 100 events at a time, and is the costliest read: at
  least one call for every tagged issue. GraphQL's `Issue.timelineItems`,
  with `CROSS_REFERENCED_EVENT`, could read the same events for 25 issues in
  the query that reads their closing references, with each PR's state read
  as it is. That would cut a pass to about one call for every 25 issues. The
  sync reads the REST timeline today. A run's timelines share its cap of
  1,000 calls with its first question to GitHub and its checks of the repos
  of the projects it reads no issues for, up to about 101 calls together,
  so about 900 go to the passes.
- **Together.** A PR with a closing keyword in its description is found both
  ways, since the keyword is a mention too. A PR linked by hand that never
  mentions the issue is found only as a closing reference. A PR that only
  mentions the issue, or aims at another branch, is found only as a
  cross-reference. GraphQL's `CrossReferencedEvent` also has
  `willCloseTarget`, which says whether the source closes the target when it
  merges. The REST event doesn't, and the sync doesn't read it.
- **Other repos.** Both ways find PRs in any repo, and a closing keyword in
  another repo's PR closes the issue when it merges. The sync drops them,
  since [spec §6](specs/v1.md#6-issues-and-claims) counts only a PR in the
  project's code repo or its issue repo.
- **The choice.** Both ways link a PR in the project's repos, so a PR there
  that only mentions an issue closes it to new claims. That errs toward not
  sending another agent to an issue someone is working on, and a person who
  wants the issue can still open a PR. Each copy records the ways its PR was
  found. Each run logs every open PR it found linked to each issue it read,
  counted by a closing reference only, a cross-reference only, and both
  ways, and the PRs in other repos apart, so staging's logs can show how
  often each way finds what the other misses, and whether mentions close
  too many issues.
- **Not checked on real GitHub yet,** since GitHub's docs don't say. The
  fake answers the first as the PR is at the read, and keeps the event.
  - Whether a cross-reference's source is the PR as it is at the read, or as
    it was when it mentioned the issue. That decides whether a closed PR
    drops out.
  - Whether the event goes when the mention is edited out.
  - Whether a mention from a repo the service token can't see is hidden from
    it.
  - Whether the source always carries `repository`. The sync falls back to
    `repository_url`.

## The policy crawler

The crawler finds repos whose docs welcome AI help, and puts them in the
admin queue as crawl candidates. The rules are in
[how-it-works.md](how-it-works.md#the-policy-crawler).

| File | What it does |
|---|---|
| `src/crawl/search.ts` | The cron job: queues the seeds, then reads the pool with GitHub's search in bands of star counts, and keeps where the pass stands |
| `src/crawl/queue.ts` | The crawl queue's consumer: reads each batch, sorts each repo, and writes the finds |
| `src/crawl/reads.ts` | What the consumer reads from GitHub: each repo's facts and folders, its files, its labels, and its pull request settings |
| `src/crawl/rules.ts` | The tiers and the suggestions, as pure functions of the files and labels |
| `src/db/seeds.ts` | The `crawl_seeds` table, the seed list |
| `src/db/crawls.ts` | The `crawl_passes` table, where each pass of the search stands |

- **A cron fills a queue, and the queue's consumer reads.** The cron job,
  at 52 minutes past each hour, makes only searches, and the consumer only
  GraphQL and REST reads, so each spends a budget of its own. Each has its
  own `ServiceGitHub`, with its allowance in `ALLOWANCES` in
  `src/sync/scheduled.ts`. A batch holds 10 repos, which keeps its GraphQL
  queries small. The consumer's `max_concurrency` of 1 keeps it to one
  batch at a time, since GitHub asks a client not to make concurrent
  requests for one user.
- **Why these shares and caps.** The crawl is the job that can wait
  longest, so its consumer leaves the most for the others: it stops while
  less than three fifths of an hourly budget is left, 500 above where a
  maintainer's refresh stops. Its cap of 60 calls covers a run of 5
  batches, about 3 queries each and 2 calls for each find, with room left.
  The search's cap of 20 calls a run keeps each run under GitHub's 30
  searches a minute, and so sets the pace of the whole crawl: at most 1,900
  repos an hour, whose reads cost about 570 GraphQL points. Its share of a
  tenth only keeps it from running the minute's searches to the end, since
  no other job searches.
- **Bands of stars.** Search serves the first 1,000 results of a query, so
  each band is small enough to serve whole, and its pages come with
  `sort=stars&order=asc`, so they don't overlap while no repo's stars
  change. The pass's first search is the band with no upper end from 1,000
  stars, whose `total_count` is the size of the pool, kept in
  `crawl_passes.pool`. The push date is set when the pass starts.
- **What a batch reads.** One GraphQL query for all its repos: each one's
  `nameWithOwner`, whether it is archived or private, its stars, when it
  was made and last pushed, its default branch and the commit it points
  to, its owner's `createdAt` through `... on User` and
  `... on Organization`, and the listings of its root, `.github/`, `docs/`,
  `PULL_REQUEST_TEMPLATE/`, `docs/PULL_REQUEST_TEMPLATE/`,
  `.claude/skills/`, and `skills/`, each entry with its `mode` and `size`.
  The listings of `.github/` and the skills folders go one level deeper,
  for the template folders and each skill. Then one query for each 50
  files and folder checks, about two for a batch of 10, each an
  `object(expression:)` alias with `<commit>:<path>` as a
  variable, so every file is read at the commit the first query named. It
  asks for each file's `text`, `isBinary`, and `isTruncated`, and for each
  listed folder's `oid` at that commit, to check that the first query
  listed that commit. The folders and names come from
  `src/projects/docs.ts`, which a proposal uses too. Beyond them it reads
  each text file in the root, `.github/`, and `docs/` with `ai`, `llm`,
  `llms`, or `genai` among the parts of its name, as an AI policy file,
  and `config.yml` among the issue templates. Only a repo in a
  listed tier costs more: `GET /repos/{owner}/{repo}`, since GitHub's
  GraphQL doesn't give who can open pull requests, checked with the
  `whyNotEligible` an admin's listing uses, then its labels, 100 to a
  query, each with `issues(states: [OPEN]) { totalCount }`.
- **No verdict on what it can't read.** `readRepos` and `readFiles` say
  why a repo can't be read whole: a file over the size limit, a symbolic
  link by its mode, `0o120000`, more templates, skills, or files named for
  AI than it reads, no text or a NUL character, or a folder whose `oid`
  differs at the commit.
  The consumer counts such a repo as `unreadable_docs`, logs why, and
  gives it no tier. A symbolic link in a folder the crawler doesn't list,
  like a linked `.claude/`, isn't seen, so a skill behind one is not read.
- **Errors, repo by repo.** GitHub puts each error at the path of the
  alias it came from, like `r3`. A `NOT_FOUND` at a repo's own alias means
  GitHub doesn't show it, and it is left out as not public. Any other error
  at a repo's alias, in the listing, the files, or the labels, fails that
  repo alone, which goes back to the queue by itself, since the file GitHub
  didn't give could be the one that bans AI. An error at no repo's alias
  fails the batch.
- **Retries.** A budget stop, a rate limit, or the run's 60 calls running
  out send the repos a batch hasn't finished back with `send({ repos },
  { delaySeconds })` on `CRAWL_QUEUE`, and acknowledge the batch, so the
  wait uses none of its tries. A stop for the budget carries when the
  budget starts over, from GitHub's `x-ratelimit-reset` or `retry-after`,
  in `SyncStopped.resetAt`, and the wait runs to then. A repo GitHub failed
  on is sent back alone. A batch of one repo that fails, any other stop,
  and any other error ask for the batch again with `retry({ delaySeconds
  })`, which takes a try. Each wait is an hour at most, and `max_retries`
  is 90, so the last retry comes inside the 4 days a queue keeps a message
  by default, as for the feed. When sending back fails, the batch is asked
  for again. `crawlerSkips` leaves out the finds a batch wrote before it
  stopped, before any read, so a repo that comes back after it was proposed
  costs no reads.
- **Only candidates.** The consumer writes with `addCandidate` alone, whose
  insert checks the do-not-list in the same statement. Nothing in
  `src/crawl/` writes a project.
- **The link** is on `https://github.com`, as the sample data's are,
  whatever `GH_WEB_URL` says, since the policy schema takes https links
  only and the GitHub fake serves plain http locally. The branch and each
  part of the path are URL-encoded.
- **Every sentence that names AI goes to the admin, with its paragraph.**
  Plain rules can miss a ban worded in a way they don't know, even in the
  sentence after one that names AI, so `readPolicy` keeps each sentence
  that names AI, that the rules read for a ban, or that bans AI with no AI
  word, with the rest of its paragraph as the file has it. A paragraph
  longer than `MAX_AI_PASSAGE`, 1,000 characters, is cut to that length
  centered on the sentence's first word that names AI, so a long sentence
  that names AI near its end still shows it, and `cutBefore` and
  `cutAfter` say where. A sentence inside the last passage
  kept from its file is not kept again. It keeps the first `MAX_AI_SENTENCES`, 60, and counts
  the rest. A find stores them in `crawl_candidates.ai_sentences` and
  `more_ai_sentences`, and `admin_queue`, the admin page, and the admin
  skill show them before a verdict, marked as the repo's words, with each
  cut said in our own words. The rules' tests hold a corpus of every ban
  wording six reviews found, 93, all read as bans, 38 made-up welcoming
  policies written alongside the rules, of which the rules read 4 as bans,
  and 12 held out from the rules, of which they read 9 as bans.
- **The safe forms are whole sentences.** `judge` in `src/crawl/rules.ts`
  reads a sentence that names AI and says no as a ban unless all of it,
  but for a list mark in front, matches one of the forms: fixed words with
  slots that each take a closed set of words, a label in quotes, or a
  path. Reviews found bans that rode along with a form that took a phrase
  out of a sentence and read the rest, so no form does that now. A test
  checks each form's example, and that no sentence that says no in the ban
  corpus is a form. The cost is more welcoming sentences read as bans,
  where a form has words added.
- **The rules' speed.** Every pattern runs on one sentence, with a few
  words of slack at most, and a sentence's end is one mark before a space,
  so no pattern tries a start again after it fails. Each file's lines are
  found once, each heading is read once, and the label names are looked
  for in the first 2,000 characters of the welcome. A label kept for
  people is kept once, whatever the number of sentences that name it. So
  the time a file takes grows with its length alone. A test reads a file at the size limit
  for each run of space and mark and each phrase a pattern starts with, as
  an AI policy, an `AGENTS.md`, and a PR template, and each takes well
  under a second.
- **Repo text reaches settings only as a label name, a trailer name, or a
  CLA link.** The canary, the line behind each suggestion, and the
  sentences that name AI go in `crawl_candidates.sources` and
  `ai_sentences`, shown to the admin as the repo's words, and no setting
  holds them. `admin_queue` marks each line of a quote, a source line, or
  a paragraph with a sentence that names AI with `> `, and puts label
  names in quotes, so
  no line of a repo's text can pass for a line of the result. It breaks a
  line at a vertical tab, a form feed, and the file, group, and record
  separators too, as some readers do.
- **The queue's name.** The Worker tells a crawl batch by its queue's name:
  `crawl`, or one ending `-crawl`, as the deploy's `<WORKER_NAME>-crawl`
  does.
- **Workers' limits.** A run of the consumer makes at most 60 calls to
  GitHub, and a few D1 queries for each batch and each find. It hasn't been
  tried on the Workers Free plan, whose 50 subrequests a run of 5 batches
  can pass.

### Open question 8: the crawl's budget

[Open question 8](specs/v1.md#open-questions) asks for the GitHub API
budget for a monthly crawl, and how many repos clear the 1,000-star and
30-day bar. This is what the build spends and how it counts, from GitHub's
docs and the GitHub fake. Neither number is measured on GitHub yet.

- **How many repos.** The first search of each pass counts them: public
  repos with at least 1,000 stars, a push in the last 30 days, not archived,
  and not forks. The count is kept in `crawl_passes.pool`, and every run's
  log line gives it, so staging's first pass answers the question.
- **What GitHub gives the service token's account.** 5,000 REST calls and
  5,000 GraphQL points an hour, and 30 searches a minute. A GraphQL query
  costs at least a point. One that asks for many connections costs more:
  GitHub adds up the requests each connection needs at its `first` or
  `last`, and divides by 100.
- **What a crawl costs, for every 10,000 repos in the pool.**
  - Search: 100 pages of 100 repos, plus a few searches for each band that
    has to be split, and one for each band that tries the rest of the pool
    with no upper end.
  - GraphQL: 1,000 batches, each one query for its facts and folders and
    about two for its files and the checks on its folders, none asking for
    a connection, so about 3,000 points. A test counts 3 queries for a
    batch of 10 of the GitHub fake's sample repos, beyond each find's own.
  - Each repo whose docs welcome AI help: one REST call, and a GraphQL query
    for each 100 of its labels, which asks for 100 labels and a count on
    each, about a point.
- **Per run and per day.**
  - The search runs once an hour, with at most 20 calls, the free first
    question included: at most 19 searches, 1,900 repos, and 190 batches an
    hour, and 456 searches and 45,600 repos a day. It stops before a search
    when fewer than 3 of the minute's 30 are left.
  - The consumer reads a batch soon after it is queued, and spends about 3
    points for each batch of 10 repos: about 570 points in an hour of
    searches at most, and about 13,700 in a day, plus 2 calls for each find.
  - So a pass takes about an hour for each 1,900 repos in the pool, and a
    pool of 10,000 about 6 hourly runs.
- **How it shares the hour with the other jobs.** Each job stops at its own
  share of what is left, so the jobs that matter most get the last of it.

  | Job | Spends mostly | Stops while less than this is left |
  |---|---|---|
  | The PR job | GraphQL | 500 of 5,000 |
  | The sync | REST | 1,000 of 5,000 |
  | A maintainer's refresh | REST | 2,500 of 5,000 |
  | The crawler's consumer | GraphQL | 3,000 of 5,000 |
  | The crawler's search | Search | 3 of 30 a minute |

  The consumer spends only the top 2,000 of either hourly budget, and about
  570 GraphQL points an hour at most, since the search queues at most 1,900
  repos an hour. A maintainer's refresh always has 500 more than the crawl
  leaves. The sync spends mostly REST, on timelines and on its checks of
  the repos of the projects it reads no issues for, up to about 101 calls a
  run with its first question, about 400 an hour, all inside its own cap.
  The crawl spends mostly GraphQL, so they seldom draw on the same budget.
- **A monthly crawl.** A pass reads the pool once, and reading it again
  each month is the re-crawl's job (#31). At these rates a pass spends
  about 3,000 GraphQL points for each 10,000 repos, well under a tenth of a
  percent of the 3.6 million points in a 30-day month, and takes about an
  hour of runs for each 1,900 repos. The search's cap on calls sets how
  long a pass takes, and GitHub's budget has room to spare.

## Sample data in development

`POST /dev/seed` and `POST /dev/work` are paths for local development only.
`pnpm seed` resets the GitHub fake, then calls `/dev/seed` when `pnpm dev`
is running. `/dev/work` takes one action at a time, from `curl` or the
end-to-end tests. The rules are in
[how-it-works.md](how-it-works.md#sample-data-in-development).

| File | What it does |
|---|---|
| `src/routes/dev.seed.ts` | The route, which hands every method to `handleDevSeed` |
| `src/dev/seed.ts` | `handleDevSeed`, and `seedSampleWork`, which writes the sample data |
| `src/dev/sample-work.ts` | The sample people, projects, issues, and claims |
| `apps/web/scripts/seed-local.mjs` | What `pnpm seed` runs to call the route |
| `src/routes/dev.work.ts` | The route, which hands every method to `handleDevWork` |
| `src/dev/work.ts` | `handleDevWork`, which works an issue as a sample person through its room |
| `src/dev/gate.ts` | `devOnlyRequest`, the check both routes make first |

- **Two checks.** `handleDevSeed` and `handleDevWork` answer `404` unless
  both hold, and both ask `devOnlyRequest` in `src/dev/gate.ts`. The first
  is `isDevelopment()`, the check the dev sign-in uses, described under
  [Sign-in](#sign-in). That check is enough for sign-in, because a deployed
  Worker can't reach a GitHub fake on the machine it was deployed from, so
  the dev sign-in fails there. The dev routes never call GitHub, so a
  Worker deployed with the local `wrangler.jsonc` would pass it. The second
  check, that the request came by one of the loopback hostnames
  [how-it-works.md](how-it-works.md#sample-data-in-development) lists,
  keeps that Worker from seeding or working an issue for anyone on its
  public hostname. Tests run the Worker as staging and as production, and
  in development on public hostnames, and see `404` and nothing written.
- **Through the issue rooms.** The claims, their lines, and the merges go
  through the same room calls the MCP tools will make, so the lines reach
  the feeds through the queue, and the claims reach D1 from the room. The
  PRs are recorded with `addPr` and `setPrState`, and the room is told each
  one closed.
- **The GitHub fake's people.** The sample work names the fake's sample
  people, with their GitHub IDs, so signing in locally as one shows their
  work. A test checks that every person, repo, and issue `pnpm seed` uses
  is in `packages/github-fake/src/sample-data.ts`. Its projects are the
  fake's made-up repos under `sample-owner`. The one project only
  `/dev/work` knows is described in
  [how-it-works.md](how-it-works.md#sample-data-in-development).
- **The end-to-end tests seed their own preview.** `home.spec.ts` checks
  the empty homepage first, then posts to `/dev/seed` and checks the page
  with its ranks and projects. `admin.spec.ts` seeds too, and works the
  admin queue the sample work leaves: two registrations and a crawler
  find, which `addCandidate` adds. The preview keeps its data apart from
  `pnpm dev`'s, as [Tests](#tests) describes, so seeding `pnpm dev` changes
  nothing there.
- **`/dev/work` adds what an action needs.** It records the person, and the
  sample project with the person who added it and its sample issues, the
  way `/dev/seed` does, so it works on an empty database. It finds the
  person's claim for them with the room's `snapshot`. A claim caches an
  issue the project hasn't, with `saveIssues`, so the issue takes claims.
  The issue page's end-to-end tests call it, and run last, as under
  [Tests](#tests).

## Configuration and secrets

The repo is public, so `wrangler.jsonc` holds bindings and settings only. The
names of deployed resources, account IDs, resource IDs, custom domains, and
secrets never go in a file. The deploy reads them from the GitHub environment
and writes them into a config file that git ignores. Where an ID is left out,
the deploy or Wrangler creates the resource on the first deploy.

Each secret the Worker reads goes by name under `secrets.required` in
`wrangler.jsonc`, and the deploy puts it. There are three.
`OAUTH_CLIENT_SECRET` and `AUTH_SECRET` are for sign-in, and `AUTH_SECRET`
also encrypts the copy of each connected agent's GitHub token.
`GH_SERVICE_TOKEN` is the read-only token the scheduled jobs and the policy
crawler read GitHub with, under [The sync](#the-sync). The OAuth library needs no secret of its
own. GitHub reserves names that start with `GITHUB_` for its own variables
and secrets, so no variable or secret of the Worker can start with it.

The rate limiters' namespace IDs are the only IDs `wrangler.jsonc` has to
carry, since Wrangler refuses a limiter without one. Each is a placeholder
that local development simulates, and a deploy replaces them with the
`SIGN_IN_LIMITER_NAMESPACE_ID`, `MCP_LIMITER_NAMESPACE_ID`, and
`TOKEN_LIMITER_NAMESPACE_ID` settings.

Local development needs none of it. `pnpm dev` applies the D1 migrations to
the local database, then runs the Worker in Miniflare, which simulates every
binding and keeps D1 and KV data on disk under `apps/web/.wrangler/`. It
also starts the GitHub fake at `http://127.0.0.1:8944`, which
`wrangler.jsonc` points the Worker at. The variables the app reads, with
safe local defaults, are listed in `apps/web/.dev.vars.example`. With no
secrets set, sign-in uses the stand-ins in `src/auth/settings.ts`, and only
in development. Wrangler warns that the secrets are missing, and locally
that is expected. The scheduled jobs read nothing without `GH_SERVICE_TOKEN`,
and `pnpm dev` doesn't run them on a schedule.

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
  caller's `permissions`, labels listed or one by name, issues and their
  timelines, issue and repo search, file contents, forks, branches and refs,
  git blobs, comparisons of two commits, pull requests, reviews, and review
  comments. GraphQL: `repository`, `viewer`, file reads with
  `object(expression:)` across many repos in one query, a repo's labels
  with the open issues that carry each, an issue with the
  open PRs that close it, through `closedByPullRequestsReferences`, a pull
  request's state, and `createCommitOnBranch`. GitHub's primary rate limits:
  each person's REST, GraphQL, and search budgets, whichever of their tokens
  made the calls, in the `x-ratelimit` headers of every answer, with a `403`,
  or a `RATE_LIMITED` GraphQL error, once one is spent. The OAuth web flow: the authorize page and the
  token endpoint, with PKCE, and an OAuth app revoking one of its tokens with
  its client ID and secret. GitHub's cap of 10 tokens for one person, app,
  and set of scopes: an 11th revokes the oldest one never used and over a
  minute old, or else the least recently used, or else the oldest. So the
  fake keeps when each token was made and last used. Each route in `src/rest.ts` names its page on
  docs.github.com, and GitHub's errors come back in GitHub's shape.
- **It records whose token made each call.** `fake.calls` lists every call
  with its endpoint, the token it carried, the login that token belongs to,
  and the status. The local server lists them at `/_fake/calls`.
- **Tests change it the way people change GitHub.** Besides merging,
  closing, and reviewing PRs and committing and deleting files, to any
  branch and with any mode, a test can open, label, assign, and close issues, open a PR
  from a branch or a fork, click Update branch on a PR, and spend part of
  a person's rate limit, as their other clients would.
- **It behaves like GitHub where the app depends on it.** Writes need push
  access. A fork belongs to whoever's token made it, and forking again
  returns the same fork. GitHub makes a new fork in the background, so for
  `forkDelayMs` after it is made, a second unless the fake was made with
  another or a test sets it, its git data answers 409
  `Git Repository is empty.`, GraphQL reads its refs and objects as null,
  and no PR can come from it. `createCommitOnBranch` refuses a stale
  expected head, makes the caller the author, and GitHub signs the commit.
  It refuses a change to a file under `.github/workflows/` from a token
  without the `workflow` scope, unless another branch of the repo has the
  same file, with the same path and content. It writes every file it adds
  as mode 100644, whatever the file was. A tree keeps each file's mode:
  100644, 100755 for an executable file, 120000 for a symbolic link, and
  160000 for a submodule, whose commit is in another repo, so
  `object(expression:)` finds nothing at its path. A commit to an open PR's
  branch moves the PR's head, as a push does. Update branch merges the
  base branch into the PR's branch, in a merge commit by whoever clicked
  it. A PR that
  mentions an issue adds a `cross-referenced` event to that issue's
  timeline, and merging it closes the issues it says it closes. A PR's head
  must be the base repo or a fork of it. Search serves the first 1,000
  results and answers a page past them with a 422. API calls need a
  User-Agent. A private repo shows only to its owner and collaborators,
  through a token with the `repo` scope, in REST, GraphQL, and search alike,
  and answers 404 to everyone else, as GitHub does for a token with
  `public_repo`.
- **Where it differs.** Tests that depend on any of these need the fake
  changed first.
  - A new fork is ready after `forkDelayMs`. GitHub takes as long as its
    background job does. What GitHub's GraphQL answers for a fork not ready
    yet isn't checked on GitHub.
  - Some answers go past what GitHub's docs say, from what GitHub is known
    to send: the 409 and its message `Git Repository is empty.` for a fork
    GitHub is still making, the message of the workflow refusal and its
    GraphQL type `FORBIDDEN`, and the type `STALE_DATA` for a commit whose
    expected head is stale. The app reads only `STALE_DATA` and the 409,
    and passes the other messages on to the agent.
  - OAuth scopes are recorded and sent back in `x-oauth-scopes`. A private
    repo checks them, for `repo`, and a workflow file, for `workflow`. A
    token with no scopes can fork and commit to a public one. GitHub's docs
    say the `workflow` scope is needed to add or change a workflow file.
    The fake asks for it to delete one too, which the docs don't say.
  - A comparison counts a line as added when the old text lacks it, and as
    removed when the new text lacks it, which is close to what GitHub
    counts for small changes. It lists a file as `renamed`, with its
    `previous_filename`, only when the file moved with its text as it was.
    GitHub also finds a rename with changed text.
  - An archived repo accepts writes.
  - A folder's contents over REST, and a comparison, leave a submodule
    out. GitHub lists one in a folder with the type `submodule`.
  - Update branch merges with no check for conflicts, and has no REST
    route.
  - `maintainer_can_modify` is kept and sent back, and the base repo's
    maintainers still can't push to the PR's branch.
  - Issue search refuses a query that names neither `is:issue` nor
    `is:pull-request`, a rule stricter than GitHub's.
  - A search qualifier it doesn't know gets a 422 naming the file to add it
    to. GitHub would read it as text.
  - A `localhost` OAuth callback allows any port, like GitHub's rule for
    `127.0.0.1`.
  - Revoking a token answers 404 when the app's credentials are wrong or
    another app issued the token. GitHub's docs name only its 204 and 422.
  - GitHub's limit of 10 new tokens an hour for one person, app, and scope
    isn't kept. Tokens don't expire, and the fake gives no refresh tokens.
  - A GraphQL query costs one point, whatever it asks for. GitHub counts
    the connections a query asks for. There are no secondary rate limits,
    and every caller without a token shares one budget.
  - A closing keyword in a commit message closes nothing when the PR
    merges. On GitHub it does, though it links no PR. The fake has no PRs
    linked by hand.
  - An app has one callback URL, and any path under it is allowed, the way
    GitHub matches with wildcard matching on.
  - Git object IDs are 40 hex characters made with an FNV hash of the
    content, so they never match a real repo's. The fake can't be cloned
    with `git`.
- **Nothing in it touches the network.** In a test, `fake.fetch` stands in
  for the global `fetch` and throws for any URL outside the fake's two base
  URLs, which default to hosts under `.test`, a domain that never resolves.
  Every URL in its responses, including avatars and raw files, points back
  at the fake.
- **The sample data** in `src/sample-data.ts` takes the shapes of the
  prototype's: donors, maintainers, and an admin, a project with tagged
  issues, one with nothing tagged, a popular repo that invites
  contributions, two registrations waiting for an admin, a repo whose
  AGENTS.md invites agents, for a crawler find, and a repo no sample work
  touches, which `pnpm skills:run` registers. `sample-owner/sample-desktop`
  keeps a vouch file at `.github/VOUCHED.td`, in the format Ghostty uses,
  which the fake serves like any file. It is the one place later issues add
  to. Every account and repo in it is made up, under `sample-owner`, except
  this project's own repo. That repo's sample issues and PRs are numbered
  from 900 up, clear of its real ones. `src/policy-samples.ts` adds the
  policy crawler's repos under `sample-policies`, also made up: one for
  each tier, each condition, and each reason the crawler leaves a repo out,
  with policy text written for the tests.
- **Local sign-in.** The fake's authorize page lists the sample people. Pick
  one, and the app gets that person's token through the same OAuth flow it
  uses with GitHub. The app's dev sign-in posts the same form for you, with
  the person's login in its `login` field.
- **Local state.** The server `pnpm dev` starts keeps its state in
  `apps/web/.wrangler/github-fake/state.json`, next to Miniflare's, so forks
  and commits survive a restart. `pnpm seed` resets it to the sample data,
  then gives the running site its sample work, as
  [Sample data](#sample-data-in-development) says. In CI, Playwright starts
  a fresh fake with the sample data. Locally it reuses a fake that is
  already running, like the one `pnpm dev` started, with whatever state
  that one has.
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
  They live in `apps/web/test/`. HTTP tests call the whole Worker with
  `workerFetch` from `apps/web/test/worker.ts`, so a test sees the same
  routing and headers a browser does. It calls the `fetch` of the Worker's
  default export in `src/server.ts` itself, with the Worker's bindings and a
  new execution context, and waits for the work the Worker hands to
  `waitUntil`. The response comes back as the Worker made it, redirects
  included. The request comes in as the runtime hands one over: its
  redirect mode is `manual`, its headers and its clones' headers refuse
  changes, and the caller's `AbortSignal` doesn't reach it. Requests
  through `exports.default.fetch` from `cloudflare:workers` get slower one
  after another in a test file, in `@cloudflare/vitest-pool-workers`
  0.22.0, even for a Worker with none of this code, as
  [workers-sdk issue 15446](https://github.com/cloudflare/workers-sdk/issues/15446)
  reports. A direct call runs in the test's own I/O context, so these
  tests can't show that the Worker keeps no stream, body, or socket from one
  request for the next, which the runtime refuses.
  `apps/web/test/runtime.test.ts` sends a few requests through
  `exports.default.fetch` on purpose, early in its file while they are
  still quick: two calls to `/mcp` from a connected agent, and a text
  stream's body, read by two readers. It also checks that `workerFetch`
  hands the Worker a request like the runtime's. The end-to-end tests reach
  pages, sign-in, the OAuth routes, disconnecting an agent, the admin
  forms, and the issue page's socket through the runtime. When a test
  cancels a stream's body through `workerFetch`, the Worker's stream ends at
  once. Behind the runtime it doesn't yet, as
  [The live feeds](#the-live-feeds) says. Code no route uses yet, like
  `src/github.ts`, is called directly. A test that calls GitHub creates the
  GitHub fake in-process and puts `fake.fetch` in place of the global
  `fetch`. `vitest.config.ts` points GitHub's URLs at hosts under `.test`.
- **Issue room tests** call a room's methods through its stub, in
  `apps/web/test/rooms/`. They set the clock with Vitest's fake `Date`, which
  the room reads too, since it runs in the same isolate. The times are in
  2100, far ahead of the real clock, so no alarm a test sets fires on its
  own. A test runs each alarm with `runDurableObjectAlarm`, and restarts a
  room with `evictDurableObject`, which keeps its storage and its
  hibernating sockets. A call's answer doesn't wait for its sends to the
  feed queue, so a test that reads the room's alarm first waits for the
  room's `outbox` to empty. A test swaps the queue on the running room for a
  stand-in that records, refuses, or never answers, the way the crash test
  swaps D1.
- **Feed tests** are in `apps/web/test/feed/`. They call a feed through its
  stub, run the Worker's `queue` handler on batches, and read the text
  streams through the Worker while the room, the queue, and the feeds run as
  they do deployed. The local
  queue waits a second for a batch, as a deployed one does. The hour's close
  is tested with a fake `Date`, which the Worker's request reads too. The
  timer that ends a quiet stream is tested by calling `handleStream` with a
  lifetime of a second on the real clock, which ends the stream in whichever
  I/O context the request runs. A fake timer fires in the test's own
  context, and could close the stream only while the Worker runs there too,
  as it does through `workerFetch`. The consumer's tests hand it batches of
  their own, which record each `retry` and its wait. `createMessageBatch`
  drops the wait.
- **Project tests** call the proposal's rules directly, and read files and
  labels from the GitHub fake with the functions in `src/projects/`. They
  live in `apps/web/test/projects/`. The maintainer's tools are tested
  through the MCP client SDK with the MCP tests.
- **Database tests** call the functions in `src/db/` against a real local
  D1. The Vitest config reads `migrations/`, and a setup file applies them
  before each test file. Each test file gets its own storage, and the tests
  in a file share it, so each database test starts by emptying every table.
  They live in `apps/web/test/db/`.
- **Sign-in tests** drive the whole flow through the Worker, with a small
  browser in `test/auth/helpers.ts` that keeps cookies and follows redirects
  by hand, and the GitHub fake in-process. Each browser has its own client
  address, so the sign-in rate limit counts it alone. The Vitest config sets
  the two secrets, as a deploy does. They live in `apps/web/test/auth/`.
- **MCP tests** connect agents with the MCP client SDK, as a harness does,
  and drive the person's side with the same small browser, against the whole
  Worker and the GitHub fake. They read the `OAUTH_KV` namespace directly to
  check what it holds. They live in `apps/web/test/mcp/`. The donor's tools'
  tests give each test's issues numbers of their own, as the sync tests do,
  since rooms keep their storage across a file, and stub `Math.random` to
  fix the random order. The vouch file's format, the random order, and the
  rules of submitted work are also tested alone, in `apps/web/test/donor/`.
  The admin's tools are tested in `apps/web/test/mcp/` too, and their
  actions are also called directly, with a spy on D1 and `fetch`, to show
  each checks the permission before it reads anything. A tool that refuses
  with a code its spec doesn't list fails the test that called it, and
  `skills.test.ts` checks the skills against the tools, as under
  [What the skills name](#what-the-skills-name). `submit.test.ts` holds the
  permission-isolation suite for `submit_work`, `open_pr`, and `my_work`:
  after each test, it checks that every GitHub call each of those tool
  calls made ran with the token of the donor whose claim it was, who also
  made the call. The fake's state shows where each branch, commit, and PR
  went, and who authored it. Its forks are ready at once, except in the
  test of a fork GitHub is still making. `apps.test.ts` reads the views
  MCP Apps hosts show as a client would, with `resources/read` and each
  tool's `_meta`, and checks what a host without MCP Apps sees: the
  `resources` capability, an empty `resources/list`, the `_meta` on three
  tools, and each answer with nothing added. How a view draws an answer
  runs in a browser, in the end-to-end tests.
- **Admin page tests** fetch `/admin` and post its forms through the Worker
  with the same small browser, signed in with the GitHub fake, and call
  `loadAdminPage` on its own for the server function's side. They live in
  `apps/web/test/admin/`. Server functions have no URL in the unit tests,
  since the Vitest build sets no base for them, so the end-to-end tests
  call the page's own.
- **End-to-end tests** run with Playwright against the production build,
  served by `vite preview` inside `workerd`, beside the GitHub fake's local
  server. The web server applies the D1 migrations first. They live in
  `apps/web/e2e/`. `streams.spec.ts` asks for the streams that exist with
  `HEAD`, since the local server holds a stream's headers until its first
  line, and no line comes there. `home.spec.ts` stands in for the homepage's
  feed with Playwright's `routeWebSocket`, and hands the page events of its
  own. The feed's side of the socket is tested in the unit tests, with real
  feeds. `issue.spec.ts` works real issue rooms through `/dev/work`, as
  several sample people at once, and the page follows them over the real
  socket. A pause needs 30 minutes, so that one test stands in for the
  room's socket and sends a pause shaped like the room's. `projects.spec.ts`
  seeds the sample projects through `/dev/seed`, and works an issue through
  `/dev/work` to see a line reach a project's page over the real socket.
  Their events reach the homepage's feed, and the seed lists projects
  there, so both run in the `rooms` project, which depends on the
  `chromium` project, once the rest are done, and the homepage's tests see
  only what they expect. `admin.spec.ts` signs in as the fake's sample
  admin, approves and rejects the seeded registrations, and replays the
  admin page's server function call as a donor. Approving lists a project
  on the homepage, so it runs in the `admin` project, which depends on
  `rooms`. It signs in three times, since every dev sign-in counts toward
  the sign-in limit of 20 a minute from one address. `skills.spec.ts`
  follows the maintain and admin skills' steps, under
  [Following the skills' steps](#following-the-skills-steps). It registers
  a project and approves it from the admin queue, where `admin.spec.ts`
  expects only what it seeded, so it runs in the `skills` project, which
  depends on `admin`.
  `mcp-apps.spec.ts` opens each view MCP Apps hosts show, read from the MCP
  server, in `apps-host.ts`, a stand-in for a host: a page that frames the
  view in a sandbox under the policy the spec builds from the view's
  declared domains, answers `ui/initialize`, sends the call's input and
  answer, and records what the view sends. It can refuse what a view asks,
  either way a host may, send the view more, and post to it from another
  frame on the page. The test hands each view answers of its own, some with
  markup in their text, answers the tool calls its buttons make, and stands
  in for an issue's socket with `routeWebSocket`. `contrastOf` measures a
  part's text against its background, so the dark tests check colors by
  what they do.
  `mcp-apps-flow.spec.ts` passes the views' tool calls to the MCP server
  with a sample donor's agent: a Pick claims a seeded issue, the card
  follows the room over the real socket, and Open PR opens a PR on the
  GitHub fake. That claim and PR would show on the homepage and to the
  admin pages' tests, so it runs last, in the `apps` project, which depends
  on `skills`. Both specs read the views with `connectAgent` from
  `scripts/skill-run.ts`.
- **The preview's own data.** `vite.config.ts` and
  `scripts/migrate-local.mjs` keep the local D1, Durable Objects, KV, and
  queues in `apps/web/.wrangler/state`, or in `LOCAL_STATE_DIR` when it is
  set. Playwright's preview sets it to `apps/web/.wrangler/e2e-state` and
  runs the migrations with `--fresh`, which empties that folder first,
  through `scripts/state-folder.mjs`. It empties only a folder inside
  `apps/web/.wrangler`, checked after every symlink on the way is followed,
  so a link there can't point it at another folder. So the tests start from
  nothing, locally as in CI, whatever `pnpm dev` holds.
  Tests in a file run in order, and `home.spec.ts` counts on it: its first
  test checks the empty homepage, and its last ones seed it.
- **Sync tests** run the tagged-issue sync, the PR job, and the Worker's
  `scheduled` handler against the GitHub fake, with the rooms and D1 as
  they run deployed, in `apps/web/test/sync/`. The fake learns the service
  token the Vitest config sets. They set the clock with a fake `Date`, as the
  room tests do, and give each test's new issues numbers of their own, since
  rooms keep their storage across a file. The scheduled tests run each cron
  in `wrangler.jsonc`, which `vitest.config.ts` reads and passes in as
  `TEST_CRONS`. A maintainer's refresh is tested through the MCP client SDK
  with the MCP tests. `delisting.test.ts` pauses and resumes projects the
  same way, as their maintainer and as an admin, on the real clock, which
  signing in an agent needs, and reads what the pages show through the
  Worker. The test of what migration `0006_delisting.sql` marks runs the
  migration's own `INSERT` again, from `TEST_MIGRATIONS`, on rows made
  before it.
- **Crawler tests** are in `apps/web/test/crawl/`. The rules' tests call
  them directly on made-up files, for every tier and condition. The rest
  run the search against the GitHub fake with a stand-in for the crawl
  queue that records each batch, then hand the batches to the consumer the
  way Queues does, with a stand-in for `CRAWL_QUEUE` that records what the
  consumer sends back, with D1 as it runs deployed, and read the admin
  queue. They use the fake's made-up `sample-policies` repos, commit
  made-up files to them, and add made-up repos to its state to fill bands
  of stars. A stand-in for `fetch` records every request, so a test shows
  which repos the crawler read, or changes GitHub's answer, to stand in for
  a symbolic link, a binary file, a push while the crawler reads, or an
  error GitHub gives for one repo. They set the clock with a fake `Date`,
  as the sync's tests do, to let a budget start over.
- **Issue page tests** load the page's data from real rooms, fetch the page
  through the Worker, and read an issue's live socket with the page's own
  fold, in `apps/web/test/issue/`. They set the clock with Vitest's fake
  `Date`, as the room tests do.
- **Project page tests** write claims, PRs, and cached issues to D1 and
  events to a project's feed, then load the projects list and a project's
  page, and fetch both through the Worker, in `apps/web/test/project/`.
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
  the GitHub fake, are not checked. The site's own cookies come from
  sign-in, which `sign-in.spec.ts` runs through the fixture, and from an
  agent's sign-in, which `mcp.spec.ts` runs.
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
  clock paused so the live wall holds still. The homepage's, in
  `home.spec.ts-snapshots/`, show it with the sample work seeded, its ranks
  and projects, and the setup open. They run under reduced motion, with six
  fixed live lines on a day long gone filling the wall. The video is masked,
  since each Chromium build draws its own video controls, and so are the
  token field and today's count, which the seeded events light with IDs and
  times that change each run. Up to 2% of pixels may differ,
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
  own test runner, and so does `apps/web/scripts/state-folder.test.mjs`,
  which checks what `--fresh` may empty. The deploy's tests fake
  Cloudflare's API, GitHub's OIDC endpoint, and Wrangler, and check the
  scripts, the deploy workflows, and
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
  A security update pull request would open before a maintainer has checked
  that the exception in [SECURITY.md](../SECURITY.md#how-we-keep-it-private)
  applies.
- **No OpenSSF Scorecard.** Its workflow checks repeat zizmor's, and its other
  checks grade practices this repo doesn't have yet, such as fuzzing and
  signed releases, so it would file alerts nobody fixes.
