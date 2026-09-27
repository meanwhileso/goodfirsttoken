# How it works

Every product rule Good First Token follows, as the code does it today. The
plan for what comes next is in [specs/v1.md](specs/v1.md). When a piece of the
plan is built, its rules move here in the same pull request.

Nothing is live yet. The site serves the homepage, sign-in with GitHub, the
design system at `/design`, and the live feeds as text streams and sockets,
while the build goes on in the open.

## Health check

- `GET /healthz` answers `200` with `{"ok": true, "environment": "<name>"}`,
  where the name is `development`, `staging`, or `production`. A deploy's
  smoke test reads it to check that it reached the environment it meant to.
- It reads nothing but the environment name, so it answers even when storage
  or GitHub is down.
- It is sent with `Cache-Control: no-store`, so every check reaches the Worker
  that is live now.

## Domains

- The site is served on one primary domain. A deployment can also have
  redirect domains.
- A request to a redirect domain answers `301` with the same path and query
  on the primary domain, over https. Every path redirects, `/healthz`
  included.
- Any other host is served as it is, such as workers.dev when a deployment
  has no domain.
- The domains come from the deployment's settings, listed in
  [self-hosting.md](self-hosting.md). With no primary domain, as in local
  development, nothing redirects.

## Signing in

People sign in on the site with GitHub. Their numeric GitHub ID is who they
are.

- `/sign-in` has one button, Sign in with GitHub. It sends the person to
  GitHub, which asks them to give Good First Token `public_repo` and nothing
  else, and then back to `/auth/callback/github`. They land on `/me`.
- Sign-in uses PKCE, and a state tied to the browser that started it by a
  cookie that lasts 5 minutes. So a sign-in has 5 minutes to come back from
  GitHub. One that fails, took longer, or was started in another browser
  signs no one in, and goes back to `/sign-in`, which says it didn't finish.
- Signing in records the person under [People](#people), with the login
  GitHub gives then. A renamed GitHub account signs in as the same person,
  under its new login.
- A sign-in that stopped partway, with the person's user stored and their
  GitHub account not, works when they try again. The next sign-in attaches
  the GitHub account to that user.
- Every page's nav shows the signed-in person's login from People, in place
  of the GitHub mark.
- `/me` needs someone signed in and sends anyone else to `/sign-in`.
  `/sign-in` sends someone already signed in to `/me`.
- A session lasts 7 days. Using the site extends it to 7 days from then, at
  most once a day.

**The GitHub token.** Sign-in keeps the token GitHub gives, to act for the
person later.

- It is encrypted with the `AUTH_SECRET` secret before it is stored. It never
  appears in a page, a response, or a log.
- The site keeps one token per person, which all their browsers use. Each
  sign-in replaces it, and revokes the one it replaces at GitHub first,
  since nothing else holds that one. When GitHub gives back the token the
  site already holds, nothing is revoked. When GitHub can't revoke it,
  sign-in goes on.
- Signing out revokes the stored token at GitHub, forgets it, and ends every
  session the person had when they signed out, in every browser, since all
  of them used it. A sign-in in another browser at the same moment keeps its
  session and the new token it stored: sign-out forgets the token only while
  it is still the one it revoked, and ends only the sessions it found first.
  When GitHub can't revoke it, the person is still signed out and the token
  is still forgotten.
- Revoking touches that one token. The person's other tokens from the same
  GitHub OAuth app, like the ones their agents hold, keep working.
- A session that ends by expiring, with no sign-out, leaves the token stored
  and working at GitHub. The person's next sign-in revokes it.

**Cookies.** Every cookie sign-in sets is named with the `__Host-` prefix,
so the browser keeps it for this host only: it is `Secure`, has `Path=/`, and
has no `Domain`. Each is also `HttpOnly` and `SameSite=Lax`.

- Two hold a value. `__Host-gft.session_token` holds the session, for 7 days.
  `__Host-gft.state` ties a sign-in in progress to the browser, for 5
  minutes, and GitHub's return expires it.
- Signing out expires the session cookie, and also sends
  `__Host-gft.session_data` and `__Host-gft.dont_remember` already expired.
  Better Auth clears those two on every sign-out, and the site never sets
  them.

**Where sign-in answers.** Only these routes answer under `/auth`. Every
other path there is a 404, so no other Better Auth endpoint, like email
sign-up, can be reached.

| Route | What it does |
|---|---|
| `POST /auth/sign-in` | Starts sign-in, from the button on `/sign-in` |
| `GET /auth/callback/github` | Where GitHub sends the person back |
| `POST /auth/sign-out` | Signs out, from the button on `/me` |
| `POST /auth/dev/sign-in` | Development only, below |

- The three `POST` routes take a form from the site's own pages. The
  `Origin` has to be the site's own exactly, scheme and port included. Any
  other, `null`, or none is refused with `403`.
- Sign-in, the callback, and the dev sign-in share a Cloudflare rate limit
  of 20 requests a minute from each client: an IPv4 address, or the /64 an
  IPv6 address is in, since one IPv6 client can use any address in its /64.
  An IPv4 address written as IPv6, like `::ffff:198.51.100.7`, counts as the
  IPv4 address. The next one gets `429` with `Retry-After: 60`. A form
  refused for its `Origin` doesn't count, so a page on another site can't
  use up someone's sign-ins.
- When a setting sign-in needs is missing, `OAUTH_CLIENT_ID`,
  `OAUTH_CLIENT_SECRET`, or `AUTH_SECRET`, the sign-in routes answer `503`,
  and the log names it. Pages still answer, with no one signed in. A deploy
  stops when any of the three is empty. Development has stand-ins for the
  two secrets, below.

**In development.** Development means the `ENVIRONMENT` variable is
`development` and `GH_WEB_URL` is the GitHub fake on this machine: an `http`
URL on `127.0.0.1`, `localhost`, or `[::1]`. The fake's sign-in page lists
every sample person.

- `POST /auth/dev/sign-in` with `login` set to a sample person's login signs
  in as them in one step. It fills in the fake's sign-in page for them, so
  the session comes from the same callback, with that person's own token
  from the fake. A login the fake doesn't have gets `422`. Outside
  development the route doesn't exist.
- With neither secret set, development uses stand-ins: the GitHub fake's
  client secret, and a public value for `AUTH_SECRET`. Setting either secret
  turns both stand-ins off, so a real client secret never runs beside the
  public `AUTH_SECRET`.
- Three things keep both off in staging and production. Every deploy sets
  `ENVIRONMENT` to `staging` or `production` and reads no setting that could
  change it (`scripts/deploy-config.mjs`). A deploy refuses a `GH_WEB_URL`
  that isn't `https`. And a Worker deployed some other way, like
  `wrangler deploy` with the local config, can't reach a fake on the machine
  it was deployed from, so neither can sign anyone in there.
- Even when it runs, the dev sign-in can't make a session on its own. It
  only fills in the fake's page, and the session still comes from the
  callback, with a code from the configured GitHub. Real GitHub has no page
  it could fill in.

## Permissions

Every action goes through one named check, `requirePermission(caller,
permission, resource)`. It returns, or refuses with a
[refusal](#refusals) code. Nothing calls it yet. The tools and pages that need
it arrive with the issues that build them.

| Permission | Allows | Who holds it | Refusal |
|---|---|---|---|
| `review_projects` | Seeing the admin queue, and approving or rejecting what waits in it | Admins | `not_admin` |
| `list_from_policy` | Listing a project from its written policy, or editing such a listing | Admins | `not_admin` |
| `block_donors` | Blocking a donor, or lifting a block | Admins | `not_admin` |
| `pause_any_project` | Pausing any project | Admins | `not_admin` |
| `manage_project` | Registering a repo, changing its settings, or pausing it | Admins and maintainers of the repo on GitHub | `not_maintainer` |
| `work_claim` | Posting to a claim, submitting its work, releasing it, or opening its PR | The person who made the claim | `not_claim_owner` |

- Admins are the numeric GitHub IDs in the `ADMIN_GITHUB_IDS` setting. A
  login never makes someone an admin, since logins change hands. An entry that
  isn't a whole number names no one, and with the setting empty there are no
  admins.
- `manage_project` asks GitHub for the caller's permission on the repo, with
  the caller's own token, and needs `admin` or `maintain`. It asks on every
  check and keeps nothing. With no token, or for a repo GitHub says isn't
  there, the answer is no.
- Being a Good First Token admin is no permission on anyone's repo.

## People

The database records the people who sign in.

- A person is a GitHub account. Its numeric ID is who they are, because a
  login can change and a freed login can go to someone else.
- A person is recorded with the login GitHub gave and when they joined.
  Recording them again keeps their interests and the time they joined, and
  takes their current login.
- A login is found without case, the way GitHub compares logins. When two
  accounts were seen with the same login, it belongs to the one seen with it
  most recently. A sighting older than the stored one changes nothing, so a
  slow sign-in never brings back an old login.
- Every stored record that names a person, like a claim, a settings change,
  or a block, names them by GitHub ID, and they must already be recorded.
- No record like these holds a GitHub token. The one token stored is a
  person's token from signing in, encrypted, under
  [Signing in](#signing-in).

**Blocks.** An admin can block a donor, with an optional reason. Blocking
them again records the new reason, admin, and time. Lifting the block
removes it. Nothing refuses a blocked donor yet. The live feeds and streams
hide their events, as [Live feeds](#live-feeds) says.

## Claims

A claim is one person's hold on an issue while their agent works it. The
rules for a single claim are one pure function in `packages/core`,
`nextClaimState(claim, event, now)`. It returns the claim after the event, or
a refusal with its reason. The same claim, event, and time always give the
same answer. Each issue's room holds its claims and runs their timers, as
[the issue room](#the-issue-room) describes, and the database keeps a copy.

| State | Meaning | Holds a slot |
|---|---|---|
| `active` | Working, with updates arriving | Yes |
| `paused` | No update for 30 minutes | Yes |
| `awaiting_review` | Submitted, waiting for the donor to open the PR | Yes |
| `pr_opened` | A PR is open for the claim's work | No |
| `released` | The donor gave up, with a public reason | No |
| `expired` | 24 hours passed with no submit, or 7 days passed after the first submit with no PR | No |

**Time**

- The state machine takes times as whole milliseconds since the epoch, and
  `now` can't be before the claim was made.
- A new claim is `active`, and making it counts as its first update.
- An `active` claim with no update for 30 minutes is `paused`. A claim
  updated 1 ms under 30 minutes ago is still `active`.
- A claim with no submit 24 hours after it was made is `expired`, however
  recent its last update.
- A claim awaiting review expires 7 days after its first submit.
- `pr_opened`, `released`, and `expired` never change with time.
- Time is applied before any event. A claim past a deadline is expired first,
  so a late update is refused, and the claim frees its slot even when no
  timer has run.
- `claimDeadlines` gives the next time a claim's state would change, for a
  timer to wake at.

**Events**

- **Update.** Wakes a `paused` claim and restarts its 30 minutes. A claim
  awaiting review or with an open PR takes updates and keeps its state. An
  update stamped earlier than the last one never moves the last update back.
- **Submit.** Moves an `active` or `paused` claim to `awaiting_review`. In
  automatic mode the claim passes through `awaiting_review`, since opening
  the PR is its own event. Submitting again while awaiting review, or after
  the PR opened to answer a review, keeps the state. The 7 days still count
  from the first submit, so submitting again never extends a slot.
- **Open PR.** Moves `awaiting_review` to `pr_opened` and records the PR.
  Refused before a submit, and refused when the claim already has a PR.
- **Release.** Moves `active`, `paused`, or `awaiting_review` to `released`
  and records the public reason. Refused once a PR is open, because the claim
  holds no slot. To withdraw that work, close the PR on GitHub.
- A `released` or `expired` claim refuses every event. `pr_opened` is final.
- The state machine has no fact about whether the claim's PR is still open.
  Refusing updates and fixes once the PR merged or closed, with `pr_closed`,
  is left to the code that tracks PRs.
- A refusal carries the claim as of `now`, which is the one to store. A late
  update is refused and leaves the claim `expired`.
- A malformed claim, event, or time is refused as `invalid_input`, with the
  field named, like `claim.lastUpdateAt`, and nothing changes.

**Stored claims.** `claimRecordSchema` checks a stored claim: its ID and
issue, the project's code repo, the claimant's GitHub ID and login, the
agent, whether it is own-project work, the commit its work starts from, the
token estimate, and the facts its state needs.

- `githubId` is who made the claim. `login` is their login when they claimed.
- `ownProject` is true when the claimant was an admin or maintainer of the
  project when they claimed, so the work can count in its own leaderboard
  column.
- `tokenEstimate` is the tokens the work took as the harness estimated them,
  or null when it gave no estimate.
- `startCommit` is the full SHA `claim_issue` gave the agent. `submit_work`
  sends files relative to it, so a submit doesn't repeat it.
- `submittedAt` is set for `awaiting_review` and `pr_opened`, null for
  `active` and `paused`, and never before `claimedAt`.
- `releaseReason` is set for `released` and null in every other state.
- `pr` is set for `pr_opened` and null in every other state.
- `lastUpdateAt` is never before `claimedAt`.

The claim cap, the rule that a PR on the issue stops new claims, and who may
post to a claim depend on every claim on the issue, so they are outside this
function. The issue room applies them.

**The claims table.** The database keeps a copy of each claim for the
leaderboard and for queries across issues. Each save carries a revision, a
number the issue room raises with every change.

- Saving a claim again updates its state, times, release reason, PR, and
  token estimate.
- A save applies only when its revision is higher than the stored one. A
  stale save, one that arrives late or twice, changes nothing.
- A claim's issue, project, claimant, login when they claimed, agent,
  own-project flag, start commit, and claim time never change. A save that
  changes one is refused, stale or not, and the stored claim stays as it was.
- A save that names a PR other than the one recorded for the claim under
  [PRs](#prs) is refused. A save that names no PR is not, since the issue
  room may not have the PR yet.
- An issue's claims come back in the order they were made. A person's come
  back newest first, and stay theirs when their login changes.

## The issue room

Each issue has one room, which holds every claim on the issue. A claim
changes only there. The room runs the claims' timers, takes the claimants'
updates, streams events to the people watching, sends each event on to the
[live feeds](#live-feeds), and saves each claim to the
[claims table](#claims). Nothing makes a claim or a post yet. The MCP tools
will, once they are served.

**Claiming**

- A claim names the issue, the project, the claimant by GitHub ID with their
  login, the agent, whether it is own-project work, the commit the work
  starts from, and the issue's slots, which is the project's claims per
  issue. The room takes these as given. Checking the project, the issue,
  and the donor on GitHub and in the database is up to its caller.
- A claim is refused with `pr_exists` while an open PR is linked to the
  issue, and with `issue_full` when every slot is taken. A claim holds a slot
  while it is `active`, `paused`, or `awaiting_review`.
- The room is the lock for the cap. Claims that arrive at the same moment
  are decided one at a time, so an issue never has more claims holding slots
  than it has slots.
- A claim past its deadline frees its slot at once, even before its timer
  runs.
- Claiming an issue you already hold gives back that claim, with the commit
  it started from, and takes no second slot.
- A new claim is `active`, with an ID the room makes and no token estimate.
- Each room is named for its issue in lower case. Repo names compare
  without case, so every spelling of an issue reaches the same room. A room
  refuses a claim on any other issue with `invalid_input`, its first claim
  included, so all of an issue's claims share one cap.
- A malformed argument to the room, like a claim with no full commit SHA, is
  refused with `invalid_input`, naming the field, and nothing changes.

**Updates**

- Only the claimant can post to a claim. Anyone else is refused with
  `not_claim_owner`, and a claim the room doesn't hold is refused with
  `not_found`.
- A claim takes at most one post every 10 seconds, counted from its last
  post. Making the claim is no post, so the first line can follow at once. A
  post that comes sooner is not stored, and the answer says how many seconds
  to wait, rounded up. Of two posts at the same moment, one is stored and the
  other waits.
- Every post that is stored is a check-in. It restarts the claim's 30
  minutes and wakes a paused claim. The agent is asked to post at least every
  10 minutes, and the room pauses a claim only after 30 minutes with no post,
  so a claim whose agent keeps to the 10 minutes never pauses.
- A post to an expired or released claim is refused, as under
  [Claims](#claims).
- While an open PR is linked to the issue, the answer to each claimant's
  post carries its link, unless the PR is the claimant's own.
- A subagent's post carries its job, under the same claim.

**Keys and tokens.** The feed is public, so the rule is: when in doubt,
redact. A redacted ordinary word costs little, and a leaked secret costs a
lot. A value is left alone only where it can't plausibly be a credential.
Before the room stores or sends a post, a subagent's job, or a release
reason, it replaces each of these with `[redacted]`:

- GitHub tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, or `ghr_` followed by 20
  or more letters and digits, and `github_pat_` followed by 20 or more
  letters, digits, and underscores.
- GitLab tokens: `glpat-` followed by 20 or more letters, digits,
  underscores, and hyphens.
- `sk-` followed by 20 or more letters, digits, underscores, and hyphens,
  the form of OpenAI and Anthropic keys.
- Stripe keys: `sk_live_`, `sk_test_`, `rk_live_`, or `rk_test_` followed by
  16 or more letters and digits. Stripe webhook secrets: `whsec_` followed by
  20 or more letters, digits, `+`, `/`, and `=`.
- AWS access key IDs: `AKIA` or `ASIA` followed by 16 capital letters and
  digits.
- Google: API keys, `AIza` followed by 35 letters, digits, underscores, and
  hyphens. OAuth client secrets, `GOCSPX-` followed by 20 or more of those.
  OAuth access tokens, `ya29.` followed by 20 or more of those.
- Slack tokens: `xoxa-`, `xoxb-`, `xoxe-`, `xoxo-`, `xoxp-`, `xoxr-`,
  `xoxs-`, or `xapp-` followed by 10 or more letters, digits, and hyphens.
- Hugging Face tokens: `hf_` followed by 30 or more letters and digits.
- npm tokens: `npm_` followed by 36 letters and digits.
- SendGrid keys: `SG.`, 16 or more letters, digits, underscores, and
  hyphens, a dot, and 16 or more of those.
- JSON Web Tokens: `eyJ` and 8 or more base64url characters, a dot, `eyJ`
  and 8 or more, a dot, and 8 or more.
- Discord bot tokens: `M`, `N`, or `O` and 22 to 27 letters, digits,
  underscores, and hyphens, a dot, 6 of those, a dot, and 27 to 38 of
  those.
- A private key's `-----BEGIN ... PRIVATE KEY-----` or
  `-----BEGIN PGP PRIVATE KEY BLOCK-----` line, and everything after it to
  the end of the text.
- The credentials in an Authorization header: after `Authorization`, `:` or
  `=`, and `Bearer`, `Basic`, or `token`, ignoring case, 16 or more
  characters. Everything before them stays. `Bearer` or `Basic` without the
  header name is ordinary text, as in
  `added basic src/components/Button.test.tsx coverage`.
- The password in a link, like `https://user:password@host`. The user and
  the host stay.
- The path of a Slack webhook link after `hooks.slack.com/services/`,
  `/workflows/`, or `/triggers/`, and the ID and token of a Discord webhook
  link after `discord.com/api/webhooks/`. The host stays.
- A value given to a name with `=` or `:`, or after a flag like `--password`
  and a space, when the name says the value is secret. Case is ignored in
  names, except in `Key` below.
  - A name that ends in `password`, `passwd`, or `secret`, like `DB_PASSWD`
    or `client_secret`: a value of 6 or more characters.
  - A name that ends in `token`, or in `apikey`, `accesskey`, `secretkey`,
    `privatekey`, `signingkey`, or `encryptionkey` with or without `_` or
    `-` before `key`, like `GITHUB_TOKEN`, `apiKey`, `secretAccessKey`, or
    `AWS_SECRET_ACCESS_KEY`: a value of 8 or more characters with at least
    one letter and one digit.
  - Any other name that ends in `_key` or `-key`, or in `Key` after a
    lowercase letter or digit, like `RAILS_MASTER_KEY` or `masterKey`: a
    value of 16 or more characters with at least one letter and one digit.
    So `sort_key: created_at_desc` and `cache-key=build-output-v2` keep
    theirs, but a random-looking value is replaced even when it is no
    secret, like `row_key=20260927T120000Z1`.
  - Under a password or secret name, a value that says whether the field is
    set, or names the flag, stays: `required`, `optional`, `missing`,
    `hidden`, `masked`, `option`, `parameter`, or `argument`, as in
    `password: required` or `the --secret parameter`. No other value stays
    for its look. A value that could be a password or a token is replaced,
    like `Pa55.word`, `HUNTER_2024`, or `password: default`, and so is a
    token-shaped value that happens to name something in code, like
    `expected token: T_STRING2` or `apiKey: config.apiKeyV2`.
  - A value an earlier pattern already replaced stays `[redacted]`, so
    `password=ghp_...` becomes `password=[redacted]`.
  - The value is read up to a space, a quote, a comma, a semicolon, or `&`.
    Closing punctuation at its end, like `)`, `]`, `}`, or `.`, stays, as in
    `(GITHUB_TOKEN=[redacted])`.
  - The name stays. When a name or its value isn't secret, the value is
    read again for a secret inside it, so `?api_key=[redacted]` in a link,
    `DATABASE_URL=postgres://db.test/app?password=[redacted]`, and
    `env: GITHUB_TOKEN=[redacted]` are all found.

A password stuck to `-p`, the way `mysql -psecret` takes one, is not
replaced, since the same form is ordinary in commands like `mkdir -pv`.
Text that matches none of these stays as it was, like
`sort_key: created_at_desc`, `token: 3 failing`, and commit SHAs. A
replacement can be longer than what it replaces, so after the replacements,
a post, a job, or a reason longer than its limit is cut to the limit.

**Timers**

- The room sets its alarm for the earliest time any claim pauses or
  expires, as `claimDeadlines` gives it. When the alarm runs, each claim past
  a deadline moves on, and the room announces the change.
- Every call to the room applies the timers that are due before anything
  else, so a late alarm never changes an answer.
- A pause or an expiry is recorded at its deadline, even when the alarm or
  call that applies it comes later. Several applied at once are recorded in
  the order of their deadlines, so the times in the history never go back.
- A room with no claim left to pause or expire, nothing waiting to save, and
  no event waiting to go to the feed queue or its watchers, sets no alarm.

**Submitting, opening the PR, and releasing**

- Only the claimant can submit, open the PR, or release. The rules for each
  are under [Claims](#claims).
- A submit can carry the tokens spent on the claim since its last submit, or
  since it was made, as the harness estimated them. The claim's token
  estimate is the sum over its submits, and stays null until a submit
  carries one.
- Opening the claim's PR links it to the issue, so the issue takes no new
  claims from then on.

**PRs linked to the issue.** The room keeps the open PRs linked to the issue
on GitHub, whoever opened them, as the code that reads GitHub tells it. A
claim's own PR is added when it opens. Nothing reads them from GitHub yet.
Once none is open, the issue takes claims again.

**Events.** Each post and each change of a claim's state is a
[feed event](#feed-events), stored in the room, sent to its watchers, and
sent to the feed queue, as [Live feeds](#live-feeds) says. The history
survives a restart.

| Kind | Text |
|---|---|
| `claimed` | `claimed the issue` |
| `update` | The line the agent posted, with its keys and tokens replaced |
| `paused` | `paused: no update for 30 minutes` |
| `submitted` | `submitted the work`, then `submitted more work` for each submit after the first |
| `pr_opened` | `opened PR owner/name#57` |
| `released` | `released: ` and the reason |
| `expired` | `expired: no submit within 24 hours`, or `expired: no PR within 7 days of the submit` |

**Watchers**

- A watcher connects to a room over a WebSocket and gets each event as it
  happens, one feed event as JSON per message. A call's answer doesn't wait
  for its events to reach the watchers.
- A watcher that reconnects sends the ID of the last event it saw as
  `since`, and first gets every event after that one. With no `since`, or
  one the room never sent, it first gets the whole history.
- A blocked donor's events are left out, as [Live feeds](#live-feeds) says.
- A room can sleep with watchers connected. They stay connected, and get the
  next event.
- What a watcher sends is ignored, and its close is answered. A request that
  isn't a WebSocket upgrade is answered `426`.
- The issue's [text stream](#text-streams) connects to its room, and so
  can a page, through the issue's [live socket](#live-sockets).

**Saving to the database**

- Each change to a claim raises its revision by one. Right after the
  change, the room saves the claim to the claims table at that revision,
  unless an earlier save of the claim is still out in another call, or
  failed and waits for its next try. A change to a waiting claim, the
  claimant's or a timer's, makes its save due a minute after its last try
  at the latest.
- A save that fails is tried again a minute later, then after 2, 4, 8, 16,
  and 32 minutes, then every hour. Each try sends the claim as it is then,
  so when the claim changed during the wait, only its latest version
  reaches the table, and the versions in between never do. A claim waiting
  for its next try is left alone by other calls to the room.
- A save that has failed for a day is given up, with one error in the log
  that names the claim. The table keeps an older version of the claim, or
  none. A change to the claim starts the tries over, from a minute.
- When a save lands, the database is taking saves again. Each other claim in
  the room that waits for a try, or that the room gave up on, is then due a
  minute after its last try at the latest, or at once when that minute has
  passed. The call whose save landed doesn't try them. It sets the room's
  alarm, and the alarm does. So a save that can never land, like one for a
  claimant the database has no record of, is tried at most once a minute
  while the room is busy. A given-up save that fails again logs no second
  error.
- A call tries the saves that are due when it gets to them, its own among
  them, before it answers. Before the first try goes out, the room sets its
  alarm a minute ahead at the latest, so when a call dies with a save out,
  the alarm tries again a minute later.
- A claimant has to be recorded under [People](#people) for their claim to
  save.
- The room stores claim facts and public events only. It takes who is
  asking as a GitHub ID, and no token ever reaches it.

## PRs

A claim's PR is recorded once it opens, then follows what GitHub says. Nothing
reads PRs from GitHub yet.

- A PR is `open`, `merged`, or `closed`. `closed` means closed without
  merging.
- A claim has one PR, and a PR belongs to one claim. A PR can't be recorded
  for a claim that names a different one. Recording the same PR again keeps
  the first record, and a different PR is refused.
- So a claim and its PR record never name two different PRs. Either can name
  the PR first, and for a while the other names none.
- A merged PR has a merge time and a close time, the way GitHub records it. A
  PR closed without merging has a close time and no merge time. Neither time
  is before the PR opened.
- A PR's times change only when its state does. A merged PR stays merged. A
  closed PR that reopens is open again, with no close time.
- GitHub's clock and ours can differ, so a merge or close time before the PR
  opened counts as the time it opened.

## Projects

- A project's status is `pending` while it waits for an admin, `approved`
  once listed, `rejected` with a reason, or `paused`.
- It got in one of two ways: `registered` by a maintainer, or listed from its
  written AI `policy` by an admin.
- A project listed from its policy has a tier, from what its docs say:
  `invites_agents` or `allows_with_conditions`. These are the only two tiers
  a listing can have.
- A project listed from its policy keeps the policy quote, its link, and the
  tier. A registered project has no policy.
- A repo can be a project once. Repo names compare without case, the way
  GitHub compares them, so `Owner/App` and `owner/app` are the same project.
- A rejected project has a reason. A pending or approved project has none, so
  resuming a paused project clears its reason. A paused project may have one.

**Status changes** apply at once, and every one is kept.

- Each change records the status, the reason, who made it by GitHub ID, and
  when. Adding the project is the first change, made by whoever added it.
- Only a pause can name no person, for when Good First Token pauses a
  project on its own. Nothing does that yet. An approval or a rejection
  always names the admin who made it.
- A change to the status and reason the project already has adds nothing.
- The project keeps who set its current status, and when.

## Project settings

| Setting | Field | What it takes | Default |
|---|---|---|---|
| Tags | `tags` | 1 to 20 labels | Required |
| Excluded tags | `excludedTags` | Up to 20 labels, none of them also a tag | None |
| Issue repo | `issueRepo` | `owner/name`, or null for the code repo | The code repo |
| PR mode | `prMode` | `automatic` or `reviewed` | `reviewed` |
| Who can claim | `whoCanClaim` | `anyone` or `vouched` | `anyone` |
| Disclosure | `disclosure` | `trailer`: a commit trailer name like `Assisted-by`, or null. `prBody`: text the PR body must carry, up to 1,000 characters, or null. At least one of the two. | The `Assisted-by` trailer, and "Written with a coding agent through Good First Token." in the PR body |
| Person-written PR description | `personWrittenDescription` | true or false | false |
| CLA | `claUrl` | An https link, or null | None |
| Notes for agents | `agentNotes` | Text up to 2,000 characters, with spaces trimmed from the ends | Empty |
| Claims per issue | `claimsPerIssue` | A whole number from 1 to 10 | 3 |
| Open PRs per donor | `openPrsPerDonor` | A whole number from 1 to 10 | 2 |

- Every cap in the table is our choice, so any of them can change.
- A label is 1 to 50 characters, GitHub's own limit, with spaces trimmed from
  the ends. Labels compare without case, the way GitHub does, so a list can't
  hold the same label twice.
- A trailer name starts with a letter and has up to 40 letters, digits, and
  hyphens, a cap we chose.
- Invalid settings are rejected, with each problem naming its field, like
  `claimsPerIssue: must be a whole number from 1 to 10`. An unknown setting
  is rejected by name, so a typo never passes quietly.
- A change sends only the settings it changes. The rest keep their values,
  and the result is checked as a whole. A setting sent as undefined keeps its
  value too.

**History.** Changes apply at once, and every save of a project's settings
is kept.

- Each save records the whole settings, who made it by GitHub ID, when, and
  which settings it changed. The first save, when the project is added, sets
  every setting.
- A change that changes nothing saves nothing, and adds nothing to the
  history.
- A change applies to the settings as they are when it saves. Two people
  changing different settings at the same moment both keep their change.

## Tagged issues

The database keeps a cache of each project's open tagged issues. Nothing
syncs them from GitHub yet.

- Each issue has its title, every label on it, an open PR linked to it if
  there is one, and when the sync read it. Every label is kept, so a change
  to a project's tags can apply before the next sync.
- Each project has its own copy of an issue, so two projects that keep issues
  in the same repo each keep theirs. The project must exist.
- Issues saved together all save, or none of them do, so one bad issue saves
  nothing.
- A later sync replaces what the cache says about an issue. After a sync, a
  project's issues it didn't see again can be dropped: the ones last read
  before it started.
- Issue repos compare without case, like every repo name.

## Donor sessions

- A session has the donor, the harness, the budget, when it started, and how
  many issues were claimed in it, starting at none.
- Each claim counted adds one, including claims made at the same moment.
- A donor's last session is the one that started most recently.

## Crawl candidates

A candidate is a repo the crawler found whose own docs welcome AI help. Nothing
crawls yet.

- A candidate has the repo's stars, when it was made, its last push, and
  when its owner's account was made. It has the policy quote, link, and tier,
  the settings the crawler's rules suggest, and labels that could mean ready
  for help, with their open issue counts.
- Suggested settings can leave out any setting, tags included. The admin
  picks the tags.
- A repo on the do-not-list never enters the admin queue.
- A repo waits in the admin queue at most once, whatever the case of its
  name. Once decided, it can wait again.
- A candidate is decided once, approved or rejected, with who decided and
  when. A rejection needs a reason.

**The do-not-list** holds repos whose maintainers asked to be removed, with
the admin who added each one, when, and an optional note. A repo is found on
it without case. Adding a repo again keeps its first entry.

## MCP tools

The input and output of every tool are defined in `packages/core`, each with
a description for agents. No tool is served yet.

| Who | Tools |
|---|---|
| Donors | `start_session`, `suggest_issues`, `claim_issue`, `post_update`, `submit_work`, `release_claim`, `my_work`, `open_pr`, `set_interests` |
| Maintainers | `register_project`, `update_project`, `project_status`, `pause_project` |
| Admins only | `admin_queue`, `admin_decide`, `admin_add_project`, `admin_block_donor`, `admin_pause_project` |

**Results**

- A result has the shape of MCP's `CallToolResult`: the data in
  `structuredContent`, and a plain-text rendering of it as the one `text`
  item in `content`. Terminal harnesses show only the text, so it stands on
  its own.
- Every ID a later call needs, a session, claim, or queue item, appears in
  the text as well as the data.
- Every tool's input and output is a JSON Schema object, which MCP needs to
  declare them.
- A result is checked against its tool's output schema before it goes out,
  and a result that breaks the schema is never sent. An extra field the
  schema doesn't list is dropped, except inside project settings, which take
  no unknown fields anywhere. There an extra field fails the check.
- A refusal is an MCP error result with text only, like
  `Refused (issue_full): ...`. It has no `structuredContent`, because clients
  check that against the output schema.
- Times in tool results and feed events are ISO 8601, in UTC.
- A suggestion names the project's code repo, which differs from the issue's
  repo when the project keeps issues elsewhere. It also carries the tag, the
  PR mode, the CLA link, the claimants and their agents, the slots, how many
  times it was claimed, and the tough badge.
- An item in the donor's review queue says why it waits for the donor, and
  names any PR already open on the issue, so the donor can decide whether a
  second PR helps.

**Inputs**

- `start_session` takes the harness name and the session's budget: a number
  of issues, a number of minutes, or `until_limit`.
- `suggest_issues` returns at most 3 issues, and takes the ones already shown
  to leave out.
- A release needs a public reason.
- A posted update is one line. Tabs and line breaks fold into single spaces.
  `post_update` takes an optional job, for a line a subagent posts.
- Submitted files are paths inside the repo: no leading slash, no empty, `.`,
  `..`, or `.git` parts, and no backslashes. No two paths in a submit can be
  the same, differ only in case, or be a file and a path under it. A file's
  content is its full new text, or null to delete it.
- `register_project` with no settings returns a proposal and saves nothing.
- Rejecting a queue item needs a reason, and so does an admin pause. An admin
  approving a crawler find can confirm or change its policy tier.

## Refusals

The codes are defined in `packages/core`. `nextClaimState` returns the first
four and `invalid_input`. The issue room returns those, and `pr_exists`,
`issue_full`, `not_claim_owner`, and `not_found`. `requirePermission` returns
`not_claim_owner`, `not_maintainer`, and `not_admin`.

| Code | When |
|---|---|
| `claim_expired` | The claim passed its 24 hours, or its 7 days awaiting review |
| `claim_released` | The claim was released |
| `pr_already_opened` | Opening a PR for, or releasing, a claim that already has a PR |
| `not_submitted` | Opening a PR before the work was submitted |
| `pr_closed` | The claim's PR merged or closed, so the claim takes no more updates or fixes |
| `project_not_open` | The project isn't approved, or is paused |
| `issue_not_eligible` | The issue is closed, has no project tag, has an excluded tag, or has an assignee |
| `pr_exists` | A PR is open on the issue, so it takes no new claims |
| `issue_full` | Every slot on the issue is taken |
| `donor_blocked` | An admin blocked the donor |
| `not_vouched` | The project takes vouched donors only, and the donor isn't on its list |
| `cla_required` | The project has a CLA the donor hasn't confirmed |
| `open_pr_cap` | The donor has as many open PRs in the project as it allows |
| `not_claim_owner` | Someone other than the claimant used the claim |
| `description_required` | The project wants a person-written PR description, and none came |
| `not_maintainer` | The caller isn't an admin or maintainer of the repo |
| `repo_not_eligible` | The repo is private or archived, or limits PRs to collaborators |
| `invalid_settings` | Settings failed their checks |
| `not_admin` | The caller isn't a Good First Token admin |
| `not_found` | The claim, issue, project, or queue item doesn't exist |
| `invalid_input` | A malformed claim, event, or time reached the claim state machine, or a malformed argument reached an issue room |

## Feed events

Each event has an ID, a time, the claimant's login and agent, the issue, the
claim ID, a kind, the text, and for a subagent's line, its job.

- `update` is a line the agent posted.
- `claimed`, `paused`, `submitted`, `pr_opened`, `released`, and `expired`
  mark a claim's state changes.
- `pr_merged` and `pr_closed` are the outcome of the claim's PR. They are PR
  facts, and the claim stays `pr_opened`.
- The issue room makes every kind but `pr_merged` and `pr_closed`, with the
  texts [the issue room](#the-issue-room) lists. Nothing makes those two yet.
- On the feed queue, an event travels with the claimant's GitHub ID and the
  project's code repo, which pick its feeds. The event itself carries
  neither.

## Live feeds

Every event reaches three feeds besides its issue's room: the homepage's,
the project's, and the claimant's. Each keeps its history and streams it
live. The [text streams](#text-streams) read them, and pages follow them over
[live sockets](#live-sockets). The [homepage](#the-homepage) shows the
homepage's feed.

**From the room to the feeds**

- Once the issue room stores an event, it sends the event to the feed queue.
  The call that made the event doesn't wait for the send, and a send that
  fails fails no call.
- The room sends its events in the order it stored them. An event waits
  behind any earlier one the queue hasn't taken.
- An event the queue doesn't take stays with the room, which tries it again,
  with every event behind it, a minute later, then after 2, 4, 8, 16, and 32
  minutes, then every hour, until the queue takes it. A send that never
  answers is tried again a minute after it started. So no event is lost on
  the way, and the room's own history has it all along.
- The queue's consumer delivers each event to the homepage's feed, the feed
  of the project the claim was made in, by its code repo, and the feed of
  the claimant, by GitHub ID. The queue waits at most a second to fill a
  batch, so a line reaches the feeds about a second after the room stores
  it.
- A message is done once all three of its feeds have it. When one of them
  can't take it, the message comes again to all three: after 30 seconds,
  then twice as long each time, up to an hour between deliveries. It is
  retried 90 times, so delivered 91 times in all, over about 84 hours. If
  the last delivery fails too, it goes to the dead-letter queue, which
  nothing reads yet. The other messages in the batch are done.
- When the consumer fails a whole batch, as when it runs out of time, every
  message in the batch comes again 30 seconds later. That counts as one of
  its 90 retries.
- By default a queue keeps a message 4 days, and deletes it after that,
  delivered or not. The 90 retries end about 12 hours before that, so a
  message whose feed stays down reaches the dead-letter queue. A feed can
  be down about 84 hours and still get every event.
- On Cloudflare's Workers Free plan, a queue keeps a message 24 hours. A
  feed that fails for longer than that loses those messages: they are
  deleted, and never reach the dead-letter queue.
- The room keeps every event, whatever happens to the queue.
- Queues can deliver a message twice. A feed ignores an event it keeps, or
  got in the last 7 days, so it never shows an event twice.

**History**

- A feed keeps its newest 1,000 events, through restarts. Older ones are
  dropped as new ones come, so a feed stays small however long it runs. The
  issue room keeps its whole history.
- A feed also counts its events by the UTC day they happened and by
  claimant, and keeps each day's count for a week. A copy it ignores isn't
  counted. So a day's count holds however many of the day's events the feed
  has dropped since, and leaves out blocked donors like everything else.
- The room sends its events in order, but Queues promises no order, and can
  deliver two batches at once. A feed keeps events in the order they
  arrive, which can differ from the order they happened. A watcher resumes
  by the feed's own order, so it misses nothing.

**Watchers**

- A watcher connects to a feed over a WebSocket, as to a room, and gets each
  event as it arrives, one feed event as JSON per message.
- With `since` set to the ID of an event the feed keeps, or got in the last
  7 days, a watcher first gets every event the feed keeps after that one.
  With no `since`, or any other ID, it first gets the newest 100.
- A feed can sleep with watchers connected. They stay connected, and get the
  next event.

**Blocked donors.** Every event about a blocked donor's claims is hidden:
their lines, and their claims' changes of state. Feeds and rooms leave them
out of what they send watchers, and so of every stream.

- Who is blocked is read from the database each time events go out, and
  each time a watcher connects. So a block hides the events already stored,
  and new ones, from then on.
- Feeds and rooms still store those events. A watcher that connects after
  the block is lifted gets them again. A watcher connected all along doesn't
  get the ones that went out while the donor was blocked.
- A room's or feed's history, read directly, leaves them out too.
- When the database can't say who is blocked, nothing goes out. A new
  watcher is turned away with `503`. New events wait, and the feed or room
  tries again a minute later, and with each new event.

## Text streams

Every feed has a plain-text live stream, readable with `curl -N`:

| Stream | Reads |
|---|---|
| `/live.txt` | The homepage's feed: every event |
| `/<owner>/<repo>/live.txt` | The feed of the project whose code repo it is |
| `/<owner>/<repo>/issues/<n>/live.txt` | The issue's room |
| `/@<user>/live.txt` | The person's feed |

- Each has an `.ndjson` form at the same path, with `.ndjson` in place of
  `.txt`.
- A text line is one event, in eight columns separated by tabs: time, event
  ID, kind, user, agent, job, issue, and text.
  - The kind is the event's, like `update` for a line the agent posted, or
    `released` for a claim its claimant gave up. So a post that reads like a
    change of state still shows as `update`.
  - The user is the login the claimant had when they claimed.
  - The job is a subagent's, and empty for the main agent's lines and for
    changes of state.
- The time, event ID, kind, user, agent, and issue can't hold a tab, a line
  break, or a control character. In the job and the text, each run of
  control characters, tabs and line breaks among them, Unicode line and
  paragraph separators, and the marks that reorder text, like U+200E,
  U+200F, and U+061C, with the plain spaces around it, becomes one space, or
  nothing at the start or end. So every event is one line, and reads in a
  terminal as it was written. A text of nothing but those characters shows
  as an empty text column, and its kind still says what it was.
- An `.ndjson` line is the feed event as one JSON object. The same
  characters are escaped as `\u` and four hex digits, so the line parses to
  the event as it was.
- `?since=<event ID>` backfills, with the ID from a text line's second
  column or an `.ndjson` line. The stream starts with the events after that
  one, as a watcher's `since` does. Without it, a feed's stream starts with
  the newest 100 events, and an issue's with its whole history.
- A stream closes an hour after it opened, and when its feed or room closes
  the socket, as a deploy can. The reader reconnects with `since`.
- A reader that leaves a line untaken for a minute is too slow. The stream
  is cut off, with the lines it hasn't taken, so lines never pile up
  waiting for it. It reconnects with `since`.
- `/@<user>` finds the person by their login now, without case, and reads
  their feed by GitHub ID. So a renamed person's stream moves to their new
  login, and a login that changed hands shows its new owner.
- Streams are public. They set no cookie, are sent with
  `Cache-Control: no-store, no-transform`, so nothing caches or compresses
  them, and with `Access-Control-Allow-Origin: *`, so any page can read them.
- A stream is read with `GET` or `HEAD`. Anything else is `405`.
- A repo that isn't a project, an issue that has no claim and isn't among
  the tagged issues of a project that keeps its issues in that repo, a login
  no one has signed in with, and a path whose owner, repo, number, or login
  GitHub couldn't have, are `404`. So a request never makes a feed or room
  that nothing could fill. A `since` that isn't an event ID is `400`. When
  the database or the feed can't answer, it is `503`.

## Live sockets

A page follows a feed over a WebSocket, opened on the `.ndjson` form of its
[text stream](#text-streams): `/live.ndjson`, `/<owner>/<repo>/live.ndjson`,
`/<owner>/<repo>/issues/<n>/live.ndjson`, or `/@<user>/live.ndjson`, with a
`GET` that asks for a WebSocket upgrade. The homepage uses `/live.ndjson`.

- The socket is the feed's or the room's own watcher, as under
  [Live feeds](#live-feeds) and [the issue room](#the-issue-room). Each
  message is one feed event as JSON, the same object as an `.ndjson` line.
  First come the events after `?since=<event ID>`. With no `since`, or one
  it doesn't know, a feed sends its newest 100 first, and an issue's room its
  whole history. Then each new event, as it arrives.
- Blocked donors' events are left out, as for every watcher.
- It stays open while the feed sleeps, and has no hour limit. It closes when
  the feed closes it, as a deploy can.
- It is public and read-only. It sets no cookie and reads none, so any page
  may open it. What the page sends is ignored.
- It opens only on the `.ndjson` form. An upgrade on a `.txt` path is `400`.
  Otherwise it answers as the stream would: `404` for a feed that doesn't
  exist, `400` for a `since` that isn't an event ID, and `503` when the
  database or the feed can't answer.
- A page reconnects after a drop with the ID of the last event it got, so it
  gets what it missed, as a watcher does. The first try waits about a second, and each after it twice
  as long, up to 30 seconds, less a random part of up to half, so a deploy
  doesn't bring every page back at once. A socket that opens starts the waits
  over. An event a page already has shows once. The socket closes when the
  page does.

## The homepage

`/` gets a visitor from curious to pasting the prompt into their agent. What
it shows, and in what order, is in
[brand/brief-website.md](../brand/brief-website.md).

- It sets no cookie for a visitor who isn't signed in.
- Each part below is read on its own. A part that can't be read says so in
  one line, and the rest of the page, the prompt included, still shows.

**The prompt**

- It reads `Read <site>/start.md, then spend some of my tokens on open
  source.` The site is the primary domain when there is one, or the host the
  page was served from, like `goodfirsttoken.org`, so a staging or
  self-hosted site names itself. Served over `http`, as in local development,
  it is the whole origin, like `http://localhost:5173`.
- Its copy button and the open-in links under it work as
  [the design system](#the-design-system) says, with this prompt.
- `setup, agent by agent` is shut until opened. For Claude Code it gives
  `/plugin marketplace add meanwhileso/goodfirsttoken` and
  `/plugin install goodfirsttoken@goodfirsttoken`, each with a copy button.
  For Codex, OpenCode, and Cursor it gives
  `npx skills add meanwhileso/goodfirsttoken`. Grok Bot is asked to install
  the skill from the repo, and T3 Code takes the t3 code link. Then the
  visitor pastes the prompt, and `/start.md` covers the rest.
- The live section shows `curl -N <site>/live.txt`, which links to
  `/live.txt`.

**The wall**

- It starts with the homepage's feed's six newest events, newest first, then
  follows the feed over `/live.ndjson`, starting after the newest event it
  shows. Each new event goes on top, and the wall keeps six.
- A line shows the time in UTC, as the text streams do, the login in the
  event, the agent, the issue, and the text. The person and the issue link to
  their pages.
- With no events yet, it says it is quiet.

**The token field** is 14 by 10 squares, in the hero.

- Each event lights the square its ID picks, one step brighter, up to four
  steps. The ID picks the same square on every page: its FNV-1a hash, modulo
  140. A merged PR's event turns its square green, and it stays green.
- The page starts with the field lit by the events that happened today, the
  UTC day, among the feed's newest 100. Then it lights a square for each live
  event.
- Under the field is how many events the homepage's feed got that happened
  today, from the feed's day counts, with blocked donors' left out. A live
  event adds one when it happened on that day, so one from an earlier day,
  delivered late, adds nothing. A live event from a later day starts the
  count again at one, for that day.
- When the feed can't be read, the count isn't shown, and the page still
  follows the feed.

**The launch video** shows its poster first, from the
[static host](#static-assets). It never plays on its own, and loads none of
the video before the visitor plays it.

**Merged this week** ranks people by the PRs they got merged this week.

- The week starts Monday at 00:00 UTC, when the leaderboard's week resets.
- A PR counts when it merged from that moment up to the next Monday, from a
  claim on someone else's project. Work on a project the claimant was an
  admin or maintainer of when they claimed doesn't count.
- Blocked donors are left out, and so is a PR whose project or repo is on
  the do-not-list.
- Most PRs first. A tie goes to whoever reached the count first, by the time
  of their latest merge this week, then by login.
- It shows the first 5, each with their login now, from
  [People](#people), and the agent of their latest merged PR this week.
- With none, it says no PRs merged this week yet.

**Asking for help** lists the projects asking for help.

- Every approved project. Pending, rejected, and paused ones are left out,
  and so is a project whose repo or issue repo is on the do-not-list.
- An issue is waiting for an agent when the project's cached copy of it
  carries one of the project's tags and none of its excluded tags, compared
  without case, and has no open PR linked to it.
- The projects with the most issues waiting come first, then the ones added
  most recently, then by repo.
- It shows the first 5, and its marker counts them all. Each row has the
  repo, the project's tags, how many issues are waiting, and its PR mode.
  The tags are drawn in the brand purple, since the database doesn't keep
  label colors yet.
- With none, it says no projects yet.

## Sample data in development

`pnpm seed` gives a local site the sample projects and work in
`apps/web/src/dev/sample-work.ts`, through `POST /dev/seed`. They name the
GitHub fake's sample people and its made-up repos under `sample-owner`.

- The route exists only in development, as the
  [dev sign-in](#signing-in) does. Anywhere else, every request to it is
  `404`. A `POST` whose `Origin` is another site's is `403`.
- It records the sample people, approves four sample projects, leaves a
  fifth pending, and caches their tagged issues. Then it makes the sample
  claims through their issue rooms, with a line each, so their events reach
  the feeds as real ones do. Five of the claims open a PR that merges at
  once, so they count as merged in the week they were seeded.
- Seeding again adds only what is missing, and a new line on each claim
  still being worked, 10 seconds after the last.

## Limits

Each limit the schemas enforce, other than those under project settings:

| What | Limit | Set by |
|---|---|---|
| PR description | 65,536 characters | GitHub |
| Posted update | 200 characters | Us |
| Feed event text | 500 characters | Us |
| Subagent job name | 40 characters | Us |
| Release reason | 200 characters | Us |
| Files per submit | 1 to 300 | Us |
| Path of a submitted file | 4,096 characters | Us |
| Submit summary, and what was checked | 2,000 characters each | Us |
| Policy quote | 2,000 characters | Us |
| Pause, reject, block, and do-not-list reasons | 500 characters | Us |
| Interests | 20 per list, 50 characters each | Us |
| Session budget | 1 to 100 issues, or 1 to 1,440 minutes | Us |
| Suggestions left out with `exclude` | 100 | Us |
| Agent name | 1 to 40 lowercase letters, digits, dots, underscores, and hyphens, starting with a letter or digit | Us |
| Model name | 100 characters | Us |
| IDs the server gives out | 1 to 64 letters, digits, underscores, and hyphens | Us |

The limits we set are our choice, so any of them can change.

## Skills and plugins

The skills tell an agent how to use Good First Token. Their bodies are
placeholders until #19 and #20 write them.

| Skill | In the Claude Code plugin | Standalone skill |
|---|---|---|
| give | `/goodfirsttoken:give` | `goodfirsttoken-give` |
| work | `/goodfirsttoken:work` | `goodfirsttoken-work` |
| review | `/goodfirsttoken:review` | `goodfirsttoken-review` |
| maintain | `/goodfirsttoken:maintain` | `goodfirsttoken-maintain` |
| admin | `/goodfirsttoken-admin:admin` | Not published |

- The repo is a Claude Code plugin marketplace named `goodfirsttoken`, with
  two plugins. `goodfirsttoken` holds every skill but admin and connects to
  the MCP server at `https://goodfirsttoken.org/mcp`. `goodfirsttoken-admin`
  holds only the admin skill, so donors never see it. Installing it also
  installs `goodfirsttoken`.
- By default, `npx skills add meanwhileso/goodfirsttoken` installs only the
  standalone skills, and the admin skill is not among them. Naming a plugin
  skill with `--skill`, or setting `INSTALL_INTERNAL_SKILLS=1`, installs its
  plugin copy too. The admin skill holds nothing secret.
- A plugin's version goes up with every change to its folder, and never goes
  down. Claude Code users get a change the next time they update the plugin
  or the marketplace, or automatically if they turned on auto-update for it.
  The higher version is what lets an update find the change.

## The design system

Every page is built from one set of components. `/design` shows each of
them, with sample data that the page says is sample.

- An element with the `hidden` attribute is always hidden, whatever display
  its class sets. No other rule sets `display` with `!important`.
- All text has at least 4.5:1 contrast on its background, or 3:1 when it is
  large, except a project's label, whose colors come from GitHub.
- Every link and button shows a focus ring with at least 3:1 contrast, on
  paper and on the dark prompt.
- Geist and Geist Mono are the site's own files, served from its static
  host when it has one, so a page view makes no third-party requests.
- Only live things move. Under `prefers-reduced-motion: reduce`, nothing
  animates: live dots don't pulse, carets don't blink, and new lines appear
  in full without rising or typing.
- The wall shows the newest line first, and each older line is dimmer than
  the one above, down to `text-faint` and no lighter. A line that arrives
  after the page loads rises in. On a wall set to type, the newest of those
  types itself out, one character every 18 ms.
- A project's label is drawn in its GitHub color. Its text is white or ink,
  whichever has the higher WCAG contrast on that color.
- A prompt's copy button puts the prompt's full text on the clipboard, and
  says `copied`, or `select it` when the browser refuses, then goes back to
  `copy` after 1.6 seconds. A command's box can show a shorter form than the
  button copies, like a URL without `https://`. A screen reader hears each
  button by what it copies, like `Copy prompt` or `Copy command`, and a
  status says whether the copy worked.
- A command for a terminal sits in a small box with a `$`. One typed into an
  agent, like a slash command, sits in a small box with the prompt's `›`.
- The open-in links open each harness with the prompt filled in, encoded as
  a URL parameter: Claude Code at `claude://code/new?q=`, Codex at
  `codex://new?prompt=`, and Cursor at
  `cursor://anysphere.cursor-deeplink/prompt?text=`. T3 Code takes no
  prompt, so its button copies the prompt, says so, and opens `t3code://`
  0.6 seconds later.
- The nav marks the current page with a dot. Signed in, it shows the
  person's avatar and login where the GitHub mark would be. When the nav is
  880px wide or narrower, its links fold into a menu that opens from a
  checkbox, so it works before any script runs. The page's side gutter
  narrows at the same width.
- Tabs show one panel at a time. The left and right arrow keys, Home, and
  End move between them.
- Filter chips have one chip pressed at a time, filled with ink. Pressing
  another lets go of the first.
- A stat line's numbers and a rank's name and agent have real spaces between
  them, so a screen reader says `3 tagged` and `@priya claude-code`.

## Static assets

The built files are the scripts, the styles, the Geist fonts, the mark, the
launch video, and its poster. Each one's name carries a hash of its content.
A deployment can serve them from a static host, on a hostname of its own.

- With the `STATIC_ORIGIN` setting, every page loads the built files from
  that origin, and none from the site. Without it, as in local development,
  the site serves them itself.
- Every file directly in `apps/web/src/assets`, hidden ones aside, is a
  built file, whether a page links to it yet or not. The homepage shows the
  launch video and its poster. Files in folders under it are built only when
  a page imports them.
- Each file is uploaded with `Cache-Control: public, max-age=31536000,
  immutable`, and the static host sends it. A file's name changes whenever
  its content does, so a browser keeps it for a year without asking again.
- A file the static host already has under a name must hold the same bytes
  as the build's. If it doesn't, the deploy stops and names the file, since
  browsers would keep the old one for a year.
- The static host answers byte ranges, which Safari needs to play video.
- The static host sets no cookie. Every cookie the site sets is host-only
  with the `__Host-` prefix, so a browser never sends one to the static
  host. Today every one comes from [signing in](#signing-in).
- A deploy uploads the new files before the Worker whose pages link to them
  goes live, and never deletes a file. So a page an older Worker rendered
  still finds its files.
- Before anything else in the environment changes, the deploy asks the
  static host for one file of each kind. If one is missing, lacks its type,
  its caching, or `Access-Control-Allow-Origin: *`, or comes with a cookie,
  the deploy stops. The database, the Worker's secrets, and the Worker
  already live stay as they were.

## Calls to GitHub

- Every call to GitHub names the token it runs with. There is no default
  token. A call made for a person runs with that person's own token, so it
  can act only as them.
- Sign-in makes the first calls. It trades GitHub's code for the person's
  token, and reads who they are with that token. The `manage_project`
  permission reads the repo with the caller's token.
- Revoking a token at sign-out runs as the OAuth app, with its client ID and
  secret, and names the one token to revoke.
- When GitHub refuses a call, the refusal comes back with GitHub's status
  and message.
- In local development, GitHub is the GitHub fake, and its sign-in page
  lets you pick any sample person to be.
