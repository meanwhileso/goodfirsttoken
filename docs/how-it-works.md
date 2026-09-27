# How it works

Every product rule Good First Token follows, as the code does it today. The
plan for what comes next is in [specs/v1.md](specs/v1.md). When a piece of the
plan is built, its rules move here in the same pull request.

Nothing is live yet. The site serves a placeholder home page and the design
system at `/design` while the build goes on in the open.

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

## People

The database records the people who sign in. Nothing signs anyone in yet.

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
- No stored record holds a GitHub token.

**Blocks.** An admin can block a donor, with an optional reason. Blocking
them again records the new reason, admin, and time. Lifting the block
removes it. Blocks are stored, and nothing refuses a blocked donor yet.

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
updates, streams events to the people watching, and saves each claim to the
[claims table](#claims). Nothing calls a room yet. The MCP tools will, once
they are served.

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
- Every spelling of an issue reaches the same room, since repo names compare
  without case.
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

**Keys and tokens.** Before the room stores or sends a post, a subagent's
job, or a release reason, it replaces each of these with `[redacted]`:

- GitHub tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, or `ghr_` followed by 20
  or more letters and digits, and `github_pat_` followed by 20 or more
  letters, digits, and underscores.
- `sk-` followed by 20 or more letters, digits, underscores, and hyphens,
  the form of OpenAI and Anthropic keys.
- Stripe keys: `sk_live_`, `sk_test_`, `rk_live_`, or `rk_test_` followed by
  16 or more letters and digits.
- AWS access key IDs: `AKIA` or `ASIA` followed by 16 capital letters and
  digits.
- Google API keys: `AIza` followed by 35 letters, digits, underscores, and
  hyphens.
- Slack tokens: `xoxa-`, `xoxb-`, `xoxe-`, `xoxo-`, `xoxp-`, `xoxr-`, or
  `xoxs-` followed by 10 or more letters, digits, and hyphens.
- npm tokens: `npm_` followed by 36 letters and digits.
- JSON Web Tokens: `eyJ` and 8 or more base64url characters, a dot, `eyJ`
  and 8 or more, a dot, and 8 or more.
- A private key's `-----BEGIN ... PRIVATE KEY-----` line and everything
  after it.
- The credentials after `Bearer` or `Basic`, ignoring case, when they are
  16 or more characters. The word before them stays.
- The password in a link, like `https://user:password@host`. The user and
  the host stay.
- A value of 8 or more characters after `=` or `:`, when the name before it
  ends in `token`, `secret`, `password`, `passwd`, `apikey`, `api_key`,
  `api-key`, `_key`, or `-key`, ignoring case. That covers
  `GITHUB_TOKEN=...`, `"password": "..."`, and `?token=...` in a link. The
  name stays, and a shorter value stays, so `token: 3 failing` reads as it
  was written.

Everything else stays as it was, like paths, links, and commit SHAs. A
replacement can be longer than what it replaces, so after the replacements,
a post, a job, or a reason longer than its limit is cut to the limit.

**Timers**

- The room sets its alarm for the earliest time any claim pauses or
  expires, as `claimDeadlines` gives it. When the alarm runs, each claim past
  a deadline moves on, and the room announces the change.
- Every call to the room applies the timers that are due before anything
  else, so a late alarm never changes an answer.
- A room with no claim left to pause or expire, and nothing waiting to save,
  sets no alarm.

**Submitting, opening the PR, and releasing**

- Only the claimant can submit, open the PR, or release. The rules for each
  are under [Claims](#claims).
- A submit can carry the tokens its work took. The claim's token estimate is
  the sum over its submits, and stays null until a submit carries one.
- Opening the claim's PR links it to the issue, so the issue takes no new
  claims from then on.

**PRs linked to the issue.** The room keeps the open PRs linked to the issue
on GitHub, whoever opened them, as the code that reads GitHub tells it. A
claim's own PR is added when it opens. Nothing reads them from GitHub yet.
Once none is open, the issue takes claims again.

**Events.** Each post and each change of a claim's state is a
[feed event](#feed-events), stored in the room and sent to its watchers. The
history survives a restart.

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
  happens, one feed event as JSON per message.
- A watcher that reconnects sends the ID of the last event it saw as
  `since`, and first gets every event after that one. With no `since`, or
  one the room never sent, it first gets the whole history.
- A room can sleep with watchers connected. They stay connected, and get the
  next event.
- What a watcher sends is ignored, and its close is answered. A request that
  isn't a WebSocket upgrade is answered `426`.
- No page or stream connects to a room yet.

**Saving to the database**

- Each change to a claim is saved to the claims table with a revision one
  higher than the last, so the table follows every change.
- A save that fails is tried again a minute later, at the claim's latest
  revision, until it lands. A claimant has to be recorded under
  [People](#people) for their claim to save.
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
`issue_full`, `not_claim_owner`, and `not_found`.

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
- Geist and Geist Mono are served by the site itself, so a page view makes no
  third-party requests.
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

## Calls to GitHub

- Every call to GitHub names the token it runs with. There is no default
  token. A call made for a person runs with that person's own token, so it
  can act only as them. Nothing calls GitHub yet. Sign-in (#8) is the first.
- When GitHub refuses a call, the refusal comes back with GitHub's status
  and message.
- In local development, GitHub is the GitHub fake, and its sign-in page
  lets you pick any sample person to be.
