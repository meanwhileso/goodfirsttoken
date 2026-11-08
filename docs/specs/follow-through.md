# Follow each PR to its end

Status: draft. The owner decided its open questions on November 8, 2026,
under Decisions. This changes how
[v1](v1.md) follows a PR after it opens, under §7 step 7, and what the
donor's skills do once a PR is open. It folds in roadmap issues
[#87](https://github.com/meanwhileso/goodfirsttoken/issues/87) and
[#88](https://github.com/meanwhileso/goodfirsttoken/issues/88), and the
follow-ups half of
[#95](https://github.com/meanwhileso/goodfirsttoken/issues/95).

## Why

A donor's work is done when its PR merges or closes. Today the agent stops
well before that. The owner's PR to omacom/omarchy,
[#18070](https://github.com/omacom/omarchy/pull/18070), shows where:

1. **Bot reviews never came back.** Greptile reviewed the PR twice, and
   both rounds found real problems. The PR job drops every review by a bot,
   so neither round became a follow-up. The agent saw them only because the
   owner was in the session and asked.
2. **Nothing woke the agent.** The PR job reads open PRs twice an hour, but
   only a session that is running hears what it found. The skills never
   schedule a check, so the work stops when the session goes idle.
3. **Every step waited for the donor.** The agent fixed the code, then
   stopped with "I haven't replied to the two Greptile threads yet." It
   replied only once the owner said "Yes, reply."

The donor should hand over a PR once and hear back when it ends. Good
First Token reads the PR. The donor's agent wakes on a schedule, answers
what reviewers wrote, keeps the branch passing and mergeable, and tells
the donor what it did. It stops to ask the donor only when the answer is
theirs to give.

## Goals

- Every open PR from Good First Token is followed until it merges or
  closes, with no session left open and no prompt from the donor.
- Reviews and comments by maintainers and by the repo's review bots,
  failing checks, and merge conflicts all come back as follow-ups.
- The agent sorts each follow-up, fixes what it should, and replies on
  GitHub from the donor's account.
- The donor hears what happened after each round, in their harness, on
  the claim's live feed, and on /me.
- The donor is interrupted only for a decision that is theirs.

## Non-goals

- A GitHub App, GitHub webhooks, or any write to GitHub with Good First
  Token's token. The donor's own tools still do every write, as in v1.
- Email or other messages from Good First Token to the donor. GitHub
  already notifies the donor of activity on their PR, and the harness and
  /me carry the rest.
- Running the donor's agent on Good First Token's servers. The agent runs
  in the donor's harness, on their machine or in the harness's own cloud.
- A script, daemon, or scheduler entry outside the harness. v1 rules them
  out under "Nothing to run outside the agent."
- Merging. Maintainers decide what merges.

## Anti-goals

Follow-through fails, however well the code works, if:

- A maintainer gets agent replies, pings, or pushes they didn't ask for.
  The agent writes one reply per maintainer comment and makes one push per
  round. It never pings a maintainer when nothing changed.
- The agent argues with a maintainer. It explains once, then does what the
  maintainer decides or asks the donor.
- A review bot and the agent answer each other without end.
- Anyone who isn't a maintainer or the repo's review bot steers the agent.
- The donor finds out days later that their agent posted something they
  wouldn't have.

## The donor's choice

Follow-through has two modes, saved per donor:

- `go_ahead`: the agent answers follow-ups, pushes fixes, and replies on
  GitHub, then tells the donor what it did.
- `ask_first`: the agent wakes on the same schedule, tells the donor what
  came in, and decides with them what to do, as the review skill does now.

The skill that records the donor's first PR with `record_pr` asks for the
mode, in give, work, or review, with `go_ahead` first. A donor who has PRs
open now is asked at their next session. The skill says what `go_ahead`
means in plain words: the agent replies on GitHub as the donor, pushes to
the PR's branch, and spends the donor's tokens on scheduled runs. A donor
who hasn't chosen gets `go_ahead`, so a PR doesn't stall on a question the
donor skipped. The donor can change the mode for all PRs or for one PR,
and can stop following one PR.

Nothing acts as a donor before the skill has said this. A donor with PRs
open now has no wake until their next session, and in that session the
skill says it before the run at the session's start. Where the harness
can't tell the donor what a run did, under Status, the skill says so too,
and points them to /me and their feed.

`go_ahead` needs a run that can push and post as the donor, as in
Harnesses. Where the donor's harness has none, the skill says so, and the
donor's PRs follow `ask_first`.

**Projects.** A project's settings narrow `go_ahead`:

- **PR mode `reviewed`.** The project wants the donor to read the diff
  before the PR opens. Once it is open, the maintainer who asked for a
  change reads the fix in the PR. So fixes push on their own in both PR
  modes. This changes three rules, which step 6 of Build order updates:
  "Weigh them with the donor" in the Rules, "decide with the donor" in the
  review skill's Follow-ups, and the server's note on follow-ups in
  packages/core/src/tools/shared.ts, which says "to weigh with the donor"
  and which docs/how-it-works.md quotes under The donor's tools. The owner
  chose this, under Decisions.
- **Person-written PR description.** The agent pushes fixes on its own,
  but never writes a reply there. It asks the donor to reply and gives
  them the link.

## What comes back as a follow-up

The PR job reads more of each open PR, in the same GraphQL query, within
its budget. Each item below is a follow-up with a `kind`.

| Kind | What it is | Who counts |
|---|---|---|
| `review` | A review that comments or asks for changes | A maintainer, or a review bot |
| `line` | A comment on a line, in any review but a dismissed one | A maintainer, or a review bot |
| `conversation` | A comment in the PR's conversation | A maintainer, or a review bot |
| `checks` | Checks on the PR's head that failed | GitHub |
| `conflict` | The PR can't merge its base without a conflict | GitHub |

**Who counts.**

- A maintainer of a review or a line comment is someone the review shows
  can push to the repo, as now.
- GitHub shows no push access on a conversation comment. Its author counts
  as a maintainer when a review of theirs on any PR in the repo showed
  push access in the last 90 days, or when they own the repo. Good First
  Token keeps those logins per repo from the reviews it reads. A
  maintainer it never saw review is missed, and the PR job's log counts
  the conversation comments it left out from people who aren't the PR's
  author or a bot.
- A review bot is an account GitHub types as `Bot`, which is a GitHub
  App's. A user account whose login ends in `[bot]` is left out, as now.
  GitHub's GraphQL gives a bot's login with no `[bot]` on the end. The
  follow-up keeps it that way, records the author's kind as `bot`, and
  tools show it with `[bot]` added.
- The PR's author is never one, as now.

**Reading them.**

- The PR job reads the 30 newest conversation comments and keeps the
  maintainers' and bots' among them. When fewer than 30 come back, it read
  them all. Otherwise the PR shows as read in part, as reviews do now.
- Text is folded and cut by the rules that apply to reviews now.
- `checks` reads the head's combined check state and the names of up to 10
  failing checks. Its ID is the head's SHA, so one follow-up stands for
  one head. A push to a new head supersedes it.
- `conflict` comes from GitHub's `mergeable` state of `CONFLICTING`. Its
  ID is the head's and the base's SHAs. `UNKNOWN`, which GitHub often
  gives before it has worked out the merge, makes no follow-up, and the
  next read tries again. A later read that finds the PR mergeable
  supersedes it.
- Neither kind has an author. Tools name GitHub as its source.
- The builder says in docs/architecture.md what the larger query costs,
  in the figures architecture uses now.

## Follow-up states

Each follow-up has a state:

| State | Meaning |
|---|---|
| `open` | No agent has sorted it |
| `waiting_reviewer` | The agent replied or pushed, and waits for the reviewer |
| `waiting_donor` | The agent asked the donor, who hasn't answered |
| `settled` | Nothing more is needed. Its `outcome` says why |

Outcomes are `fixed`, `replied`, `no_change`, `resolved` for a thread its
reviewer resolved, and `superseded` for checks or a conflict a new read
replaced.

- `submit_work` takes `answers`, the IDs of the follow-ups its fix
  answers, and settles only those, as `fixed`. Without `answers`, a submit
  answers every follow-up shown before it, as now, so `ask_first` and
  older skills work as they do.
- A new tool, `sort_follow_ups`, sets the state of follow-ups with no
  fix: `waiting_reviewer`, `waiting_donor` with the question, or `settled`
  with an outcome and, for `replied`, the reply's link. It takes over
  #88's "settle a follow-up without a fix".
- Only the claim's donor can change its follow-ups.
- A follow-up read after the change still shows.
- `answeredAt` stays, set when a follow-up settles.
- The agent reads whether a thread is resolved with the donor's GitHub
  CLI. Good First Token's PR job doesn't read thread state, so its budget
  stays as it is.

## The follow-through run

A run is one pass over the donor's open PRs. It happens when the harness
wakes the agent on schedule, and at the start of any session with the
give or review skill. A new skill, `follow`, holds the steps, so a
scheduled run starts it the way its harness starts a skill:
`/goodfirsttoken:follow` in Claude Code, `$goodfirsttoken-follow` in Codex,
and `/goodfirsttoken-follow` elsewhere. The builder checks each harness's
form.

1. Call `my_work` with the run's wake ID, when a wake started it. When
   `followThrough.dueNow` is false, and the donor's GitHub CLI shows
   nothing new, as in step 3, end the run and say nothing. Most runs end
   here.
2. For each PR that is due, take its lease with `follow_pr`, as in Two
   agents at once. Skip a PR another run holds.
3. Read the PR with the donor's GitHub CLI: its state, the counts of its
   reviews and conversation comments, its head's check state, and whether
   it can merge. When any of them changed since Good First Token's record,
   call `check_pr`. That is the only use of the GitHub CLI's read of
   comments. The agent acts only on the follow-ups Good First Token lists.
4. Pull the claim's branch into the run's work folder, cloning it the
   first time.
5. Sort each `open` follow-up, as in Sorting.
6. Make the fixes as one round: commit with the trailer, run the repo's
   tests and checks, push, and call `submit_work` with the new head and
   `answers`.
7. Reply on GitHub, as in Replies, and record each reply with
   `sort_follow_ups`.
8. Post status, as in Status.
9. Give back the lease with `follow_pr`. The wake's own schedule starts
   the next run. A run never changes its wake, since some harnesses ask
   the donor to approve each change to a schedule.

A round is what one run does on one PR: at most one push and one set of
replies.

**A run that only reports.** A scheduled run at the `notify` level, under
Harnesses, and a scheduled run for a PR in `ask_first`, does steps 1 and
8 only. It takes no lease. It tells the donor what came in, and what it
would do with each follow-up. It changes no follow-up's state, so the next
`full` run, or the donor's next session, sorts them. Each wake reports a
follow-up once: `my_work` with the wake ID lists, under `newForWake`, the
follow-ups that wake hasn't been given yet. A run that only reports
doesn't mark a follow-up shown, so a later submit with no `answers` can't
settle one the donor never saw.

In a session the donor is in, an `ask_first` PR runs every step, and the
agent sorts its follow-ups with the donor, as the review skill does now.

**What an unattended run may do.** A run with no person watching runs
only git, GitHub's CLI or API with the donor's credential for the steps
above, and the test, build, and lint commands the repo's own docs or CI
name. A fix that needs any other command, or a command a comment names,
waits for the donor.

## Sorting

The agent reads each follow-up against the issue, the diff, and the repo's
rules, and checks each claim in it against the code before it acts.

| Sort | When | What the agent does |
|---|---|---|
| Fix | The comment asks for a change within the issue, and the agent confirmed it holds | Changes the code in this round. The follow-up settles `fixed` with the submit |
| Answer | The comment asks a question about the change | Replies with the answer. A maintainer's waits for them. A bot's settles `replied` |
| Explain | The agent checked the comment and finds it wrong | Replies once with what it checked. A maintainer's waits for them. A bot's settles `no_change` |
| Nothing | An approval, thanks, a bot's summary that asks for nothing, or something already fixed | Settles `no_change`, with no reply |
| Ask the donor | Anything in the list below | Sets `waiting_donor` with the question, tells the donor, and goes on with the rest |

The agent asks the donor when:

- The comment asks for work beyond the issue, a design choice the issue
  doesn't settle, or anything the Rules forbid.
- The comment speaks to the person: a question for the donor, a request
  to sign something, or doubt that a person checked the work.
- A maintainer says the project doesn't want agent PRs, asks the agent to
  stop, or asks to close the PR. The agent replies nothing, and stops all
  work on that PR until the donor answers.
- Two reviewers ask for opposite things.
- A maintainer still disagrees after the agent explained once.
- The fix needs something the agent can't do or check here, like a test
  on hardware, or a command beyond what an unattended run may do.
- A failing check fails on the base branch too, or the agent can't tell
  whether the change caused it.
- The fix leaves the repo's tests failing.

Each question to the donor names the PR, quotes the comment as the
reviewer wrote it, says what the agent thinks, and gives the choices it
sees. The donor answers in any session. The next run takes the answer
from that session, or the donor's agent acts on it there.

**Checks.** The agent reads the failing check's log with the donor's
GitHub CLI, reproduces it where it can, and fixes it when the change
caused it. A workflow run that waits for a maintainer to approve it, as
GitHub does for a first-time contributor, needs no fix. The agent tells
the donor once. The builder checks how GitHub shows such a run in the
check state.

**Conflicts.** The agent merges the base branch into the claim's branch,
resolves the conflict, and runs the tests. It never rebases or
force-pushes an open PR's branch, as the review skill says now.

## Replies

- The agent posts from the donor's account with the donor's GitHub CLI.
- **To a maintainer.** A line comment gets its reply in its thread. The
  round's review and conversation comments get one conversation comment
  that answers them all, quoting a short line of each. A reply says what
  changed and the commit's short SHA, or the answer, in a few sentences.
  The agent leaves a maintainer's thread for the maintainer to resolve.
- **To a bot.** A fixed bot thread gets no reply. The agent resolves it
  once the fix is pushed, and the commit message says what changed. A bot
  comment the agent explains gets one short reply, and then the agent
  resolves its thread.
- Each reply follows the repo's rules for AI help, and ends with the
  project's disclosure trailer line, as
  `Assisted-by: claude-code (claude-opus-5-5)`.
- No reply on a PR whose project wants a person-written description. The
  agent asks the donor to reply, with the link.
- **Asking for another review.** When the round settles every change a
  maintainer asked for in a review that asked for changes, the agent asks
  that maintainer to review again, once, where GitHub lets the donor. The
  builder checks whether GitHub's API allows it for a PR from a fork.
  Where it doesn't, the round's reply says the changes are in.
- No other message to a maintainer. A PR that waits 14 days with no
  reviewer activity since the last push is the donor's to nudge, and the
  agent tells them once.

## Limits

- At most 3 rounds per PR in a day, and 10 in all. Then the agent asks
  the donor whether to go on, and the PR waits for them.
- At most 3 rounds on a PR answer bots. After that, bot follow-ups on it
  settle `no_change`, and the agent tells the donor once. A maintainer who
  repeats a bot's point counts as a maintainer.
- A follow-up's text is untrusted repo text, as the Rules say now.
  Maintainers and review bots quote other people, so the agent does
  nothing a comment asks beyond the issue, whoever wrote it.
- `check_pr` takes at most 30 checks an hour from one donor, as now. A
  run calls it only when the GitHub CLI shows a change, so the limit holds.
  When the answer says `later`, the run goes on with what Good First Token
  has.
- A PR with no reviewer activity for 30 days stops being checked on a
  schedule. The agent tells the donor once. The PR job still reads it, and
  any session or `check_pr` that finds new activity starts the schedule
  again.

## Two agents at once

A scheduled run and a session the donor started can wake together. Only
one agent follows a PR at a time.

- `follow_pr` takes or gives back a PR's lease, keyed by a run ID the run
  makes up when it starts. `my_work` takes no lease, so listing the review
  queue locks nothing.
- A lease lasts 30 minutes. Each `follow_pr`, `check_pr`, `post_update`,
  or `submit_work` on the claim from the same run renews it. A run that
  waits in a session through a PR's first 2 hours renews it with each
  15-minute check.
- Another run that asks gets `following`, with when the lease ends, and
  leaves the PR.

## Waking up

Good First Token decides when each PR is due. The harness wakes the agent.

**When a PR is due.** `my_work` and `check_pr` answer with
`followThrough`: `dueNow`, `nextCheckAt` across the donor's PRs, and each
PR's state, lease, and round counts. A PR is due when it has an `open`
follow-up or when its own next check comes. The next check comes:

- every 15 minutes for 2 hours after the agent's last push or a new
  follow-up, since bots and checks answer fast,
- then every hour until 24 hours have passed,
- then every 4 hours until 7 days,
- then once a day, until 30 days with no reviewer activity, as in Limits.

A PR whose follow-ups all wait for the donor, or that the donor stopped
following, isn't due for a `full` run. A run that only reports, as under
The follow-through run, is due when its wake has follow-ups it wasn't
given.

A PR in its first 2 hours stays in the run where the harness can wait in
a session: the agent waits for its 15-minute checks, and ends the run when
nothing is due within the hour. A harness whose wake can't come that often
checks at its own shortest interval. Where the harness takes a trigger,
Good First Token also starts a run when a follow-up comes, as in Waking a
run when a follow-up comes.

**Stalled PRs.** A PR with an `open` follow-up that no run sorted for 24
hours is `stalled`. `start_session` and `my_work` list it first, and /me
shows it at the top with the step to take.

## Harnesses

Follow-through works in every harness the skills support: Claude Code,
Codex and the ChatGPT desktop app, which share Codex's config, OpenCode,
Cursor, and Grok Bot. ChatGPT on the web and Grok's app can also report,
for a donor who works in one of those. Each harness does what it can, and
the skill tells the donor which level they get.

**What a run needs.**

1. **A wake.** Something in the harness starts the run with no one at the
   keyboard: a scheduled task, a routine, an automation, or a loop in a
   session that stays open.
2. **Good First Token's tools.** A run with no one watching can't sign in.
   The session that sets the wake up signs in first, the way that harness
   keeps a server's sign-in for its runs. A connection lasts 30 days from
   its last refresh, under Signing in in docs/how-it-works.md, so runs a
   few hours apart keep it.
3. **Git and GitHub as the donor.** The run pushes and posts with a
   credential that acts as the donor's own GitHub account.

**Writing as the donor.**

- `my_work` names the donor's GitHub login, as `start_session` does.
  Before any write, the run checks that `gh api user` gives that login.
  When it doesn't, the run writes nothing and tells the donor.
- A run writes to GitHub only with git and the GitHub CLI. It never uses a
  harness's own GitHub tools or app, like a cloud agent's comment tool,
  since those post as an app or bot.
- Some harnesses block part of the GitHub CLI, like its GraphQL calls. A
  run there uses GitHub's REST API through `gh api` with the same
  credential. A step that only GraphQL has, like resolving a thread, is
  left for the donor, and the run says so.

**Levels.** The follow skill finds the level when it sets the wake up, and
saves it with `set_follow_through`.

| Level | The run has | What the run does |
|---|---|---|
| `full` | All three | Everything in this spec |
| `notify` | A wake and the tools, but no git, or no write as the donor | Reports, as in A run that only reports |
| `session` | No wake | Nothing until the donor starts a session with a Good First Token skill. A CLI session that stays open keeps a loop |

**Each harness.** From each product's docs on November 8, 2026. "Check"
marks what the docs don't say. The builder tries each one in the harness
before the skill relies on it.

| Harness | Wake | Runs on | Writes as the donor | Level |
|---|---|---|---|---|
| Claude Code desktop app | A scheduled task. Runs while the app is open and the computer is awake, with one catch-up run for a time missed in the last 7 days | The donor's machine | The donor's git and GitHub CLI | `full` |
| Claude Code in a terminal | A loop for as long as the session runs, up to 7 days | The donor's machine | The donor's git and GitHub CLI | `session` |
| Claude Code cloud scheduled tasks | Cron, at most hourly, or its API trigger | Anthropic's cloud | Commits carry the user's GitHub account. The GitHub proxy blocks GraphQL and serves only repos attached to the task, so each new repo and fork means editing the task. Good First Token's server has to be a claude.ai connector to reach the run | `notify` |
| Codex in the ChatGPT desktop app | A scheduled task. Runs while the app is open and the machine is on | The donor's machine | The donor's git and GitHub CLI. The task needs full access, since network calls fail in its read-only and workspace-write modes. Check: Good First Token's server in a scheduled task | `full` once checked |
| Grok Bot | A routine, at least 5 minutes apart, or a webhook. Approval cards a routine raises expire after 30 minutes, and routines can pause after a long time without the donor | Its own cloud computer, shared by the donor's Bots | When the donor signs the GitHub CLI in on the Bot's computer. Check it | `full` when signed in, else `notify` |
| Cursor Automations | Cron, or a webhook. GitHub review triggers don't fire on PRs from forks | Cursor's cloud | Cursor's comments post as the `cursor` account, so a run needs a donor token in Cursor's secrets. Check it | `full` with a token, else `notify` |
| Codex CLI, Cursor's editor and CLI, OpenCode, Grok Build | None built in | The donor's machine | The donor's git and GitHub CLI | `session` |
| ChatGPT on the web and phone | A scheduled task, at most hourly, with 3 to 15 active by plan | OpenAI's cloud | None. Chat has no git. Check: Good First Token's server in a scheduled task | `notify` once checked |
| Grok's Automations in the Grok app | Daily at most | xAI's cloud | None. No terminal is documented. Check: Good First Token's server in an automation | `notify` once checked |

The last two can't claim or submit, since they have no git. They report on
PRs a donor's other harness opened. The tools take `chatgpt` as a new
`agent` value for them, and Grok's app reports as `grok`.

**A donor token in a cloud harness.** Grok Bot and Cursor Automations run
with no GitHub CLI of the donor's. The donor can sign the GitHub CLI in on
the Bot's computer, or store a GitHub token in Cursor's secrets. Before
the donor does, the skill tells them:

- GitHub's fine-grained tokens can't write to a public repo the donor
  isn't a member of. So the token is a classic token with `public_repo`,
  which can write to every public repo the donor can.
- Grok Bot shares its computer's command-line credentials across all of
  the donor's Bots. A Bot shared with a team shares its secrets too.
- Cursor's secrets are shared across the workspace.
- The run reads review comments, which are untrusted text, beside that
  token.
- How to revoke it.

The token stays in the harness and never goes to Good First Token. The
skill sets this up only when the donor says yes after reading this. The
owner chose to offer it, under Decisions.

**What the rules can't enforce.** What an unattended run may do is a rule
the skill gives the agent. A harness's own permissions enforce it only
where the donor sets them that way. Codex's scheduled tasks need full
access, so there the rule is the agent's alone. The skill tells the donor
this.

**Setting the wake up.** The follow skill does this with the donor in a
session, when the donor's first PR is recorded. It does it again in any
session that finds a PR open and no wake, as after a PR opens again. It
removes the wake in a session that finds no PR open. A run with no one
watching never changes a wake.

1. Check what the run will have: the tools, git, and `gh api user` as the
   donor.
2. Set up the most lasting wake the harness has, as in the table, to run
   the follow skill. It runs every 15 minutes, or as often as the harness
   allows when that is less often. Every run ends at step 1 when nothing
   is due.
3. Ask the donor for the permissions an unattended run needs, as in What
   an unattended run may do, in the harness's own terms. The builder
   checks how a run in each harness meets a permission prompt.
4. Save the wake with `set_follow_through`: the harness, the level, and
   the interval. The answer gives the wake's ID, which goes in the wake's
   prompt.
5. Where the harness takes a trigger, set one up, as in Waking a run when
   a follow-up comes.
6. Tell the donor the level, what the wake does, about what a run costs in
   tokens, and how to turn it off. The builder measures a run that ends at
   step 1 and a typical round, and the skill gives those figures.

A local run's prompt names a work folder on the donor's machine for
clones. That path never goes to Good First Token, a feed, or GitHub.

A donor can set wakes in more than one harness, like the desktop app and
Grok Bot. Leases keep two runs off one PR. A run that only reports changes
nothing, so it never holds up a `full` run.

**A wake that stopped.** Good First Token keeps when each wake's runs last
called `my_work` with its ID. A wake with no run for 24 hours while a PR
of the donor's is open, as when the desktop app stays closed, shows on /me
and in the donor's next session, with when it last ran.

## Waking a run when a follow-up comes

Three harnesses start a run when called over HTTP: Claude Code's cloud
scheduled tasks through their API trigger, and Grok Bot and Cursor
Automations through a webhook. For a wake in one of them, Good First Token
calls the donor's trigger when a follow-up comes, so the run starts soon
after the review instead of at the next scheduled time.

**What this changes in v1.** v1 rules out webhooks and donated API keys
under Non-goals. Those are GitHub's webhooks and keys that pay for agents
on Good First Token's servers, and neither comes back here. The trigger is
a call from Good First Token to the donor's own harness, and its key only
starts a run there, on the donor's own plan. It can't call a model or
reach GitHub. The run is still the donor's agent in the donor's harness,
as v1 asks.

**Setting it up.** In step 5 of Setting the wake up, the skill asks the
donor to make a trigger in the harness for the follow skill's run, then
gives them a link to /me to paste its URL and key. The key goes from the
harness to /me and never through the agent, so it stays out of the
session's transcript.

- /me saves it only when the URL is HTTPS and its host and path match the
  pattern the code lists for that harness. The list is in the code, one
  pattern per harness, and the builder checks each.
- The key is stored encrypted with `AUTH_SECRET` through Better Auth's
  `symmetricEncrypt`, as `connected_agents` stores an agent's token. No
  tool and no page shows it again. /me shows that a trigger is on, its
  host, and when it last fired.
- Removing the wake, or the donor's account, removes its trigger. The
  donor can also turn it off on /me, and revoke the key in the harness.

**When Good First Token calls it.** Each pass of the PR job, after it
writes what it read, calls each wake with a trigger that has follow-ups
it hasn't been called for:

- A `full` wake is called for an `open` follow-up on a PR no run holds.
  A `notify` wake is called for a follow-up it hasn't been given.
- No call for a PR the donor stopped following, one whose follow-ups all
  wait for the donor, or one at its round limits under Limits. A bot's
  follow-up on a PR past its bot rounds brings no call.
- At most one call per wake in 15 minutes, and 12 in a day. A follow-up
  skipped for the lease or these limits goes with a later pass's call, so
  none waits for the schedule.
- Each call waits at most 5 seconds. A pass makes at most 50 calls, and
  the rest go with the next pass. The builder adds the calls to the PR
  job's costs in docs/architecture.md.

The PR job reads PRs twice an hour, so a run usually starts within 30
minutes of a review. A PR the read limits leave for a later pass, or a
call held by the limits above, waits longer.

**What the call sends.** Only what the harness needs to start the run,
and the wake's ID where the call can carry it. No repo text, no PR link,
and no GitHub login. The run passes the ID to `my_work` and takes nothing
else from the call. It reads the rest with `my_work`, as any run does.
The call follows no redirects.

**When it fails.**

- A timeout, a 5xx answer, or a 429 answer counts as one failed call, and
  the next pass tries again. A 429 also holds the wake's calls for an hour.
- An answer that says the key is wrong or the trigger is gone, or three
  failed calls in a row, turns the trigger off. /me and the donor's next
  session say so, with the step to fix it.

**The schedule stays.** The trigger adds runs and never replaces the
wake's schedule from step 2 of Setting the wake up. So a PR keeps its
15-minute checks in its first 2 hours where the harness allows them, and
a trigger that turns off changes nothing else. It helps most where the
schedule comes least often, as in Claude Code's cloud scheduled tasks,
which run at most hourly.

**Check, for each harness:** the trigger's URL, how it takes the key,
whether a call can carry the wake's ID, which answer means the key is
wrong, and how often the harness lets a trigger fire.

## Status

**In the harness.** A run that did something ends with one message to the
donor: each PR, what reviewers wrote, what the agent changed, what it
replied with links, and what it waits for. A run that did nothing says
nothing. The message goes where the harness puts a run's result:

| Harness | Where the donor sees it |
|---|---|
| Claude Code desktop app | The run's session in the app. Claude Code's push notification tool, for a question or a PR that ended. Check it from a scheduled task |
| Claude Code cloud scheduled tasks | The task's list of runs |
| Codex in the ChatGPT desktop app | The scheduled tasks view, marked unread |
| ChatGPT on the web and phone | Push or email, by the donor's ChatGPT settings |
| Grok Bot | Its notice when a run is done. Check which channel |
| Grok's Automations | Email or the app's notifications, as the donor set them |
| Cursor Automations | A Slack message, when the donor connected Slack. Never a comment on the PR |

Where the harness can't notify, /me and the donor's own feed carry it.

**When it needs the donor.** A question stays first in `start_session`
and `my_work`, and on /me, until the donor answers.

**On the live feed.** The agent posts with `post_update` as it works,
under the claim, as the Rules say now. The donor can follow every claim of
theirs at `/@<login>/live.ndjson`, in any harness or none. Lines like
`read 2 comments from greptile-apps[bot]`,
`fixed the root base path (src/router.ts)`,
`pushed 5a6f4e3, replied to 2 threads`, and
`asked the donor about a second reviewer's request`.

**On /me.** Each open PR shows its state, `waiting for a reviewer`,
`your agent is on it`, `waiting for you`, or `stalled`, with the last
round's summary, its follow-ups, and when it is checked next.

## Tools

- `my_work` and `start_session` list follow-ups with their `kind`, the
  author's kind, and their state, and answer with `followThrough`.
- `check_pr` answers with `followThrough` too.
- `submit_work` takes `answers`.
- New `sort_follow_ups`, as in Follow-up states.
- New `follow_pr`, as in Two agents at once.
- New `set_follow_through`: `go_ahead` or `ask_first` for the donor or one
  PR, or `off` for one PR. It also saves a wake, with the harness, its
  level, and its interval, and answers with the wake's ID. It removes a
  wake by its ID.
- `my_work` names the donor's GitHub login. It takes a wake's ID, records
  the call for A wake that stopped, and lists `newForWake`.
- The tools take `chatgpt` as an `agent` value.
- Follow-up records gain `kind`, `authorKind`, `state`, `outcome`, and the
  question for the donor. The reviewer's login allows a bot's login.
- PRs gain the lease, the round counts, the agent's last push, and the
  last reviewer activity.
- Each repo keeps the logins whose reviews showed push access, with when.
- Wakes gain an optional trigger: its URL, its key encrypted, whether it
  is on, its last call, and its failures in a row. /me gains the form that
  saves it. No tool takes or returns the key.

## What stays

- v1's write path. The donor's tools push and post, and Good First Token
  writes nothing to GitHub.
- How a PR ends. A merge or close is told once, with the share link for a
  merge.
- The PR job's schedule and its global read limits.
- `ask_first` works as the review skill does now, with a wake added.

## Decisions

The owner decided these on November 8, 2026.

1. **Reviewed projects push on their own.** In PR mode `reviewed`, fixes
   push without the donor reading them first, since the maintainer reads
   the fix in the PR. Holding each fix for the donor was the other choice.
2. **A donor who hasn't chosen gets `go_ahead`**, so a skipped question
   doesn't stall a PR. `ask_first` by default was the other choice.
3. **No nudges to maintainers.** A PR that waits 14 days is the donor's to
   nudge.
4. **Harnesses with no scheduler follow through only in a session.** Codex
   CLI, Cursor's editor and CLI, OpenCode, and Grok Build stay at
   `session`, since v1 rules out anything that runs outside the harness.
   An entry in the donor's system scheduler that starts the CLI headless
   was the other choice.
5. **Good First Token calls a harness's trigger when a follow-up comes**,
   as in Waking a run when a follow-up comes.
6. **A donor token in a cloud harness is offered**, with the warnings
   under A donor token in a cloud harness. Keeping cloud harnesses at
   `notify` was the other choice.

## Build order

Each is one issue and one PR, in this order.

1. Bring back bot reviews and conversation comments as follow-ups, with
   `kind`, the author's kind, and the logins with push access per repo.
   This takes over #87.
2. Read failing checks and conflicts as follow-ups.
3. Add follow-up states, `sort_follow_ups`, and `answers` on
   `submit_work`. This takes over #88.
4. Save the donor's mode with `set_follow_through`, and ask for it when a
   skill records the first PR.
5. Answer with `followThrough`, and add `follow_pr`: due PRs, the next
   check, leases, round counts, and stalled PRs. Save wakes with
   `set_follow_through`, and have `my_work` take a wake's ID, list
   `newForWake`, and record each wake's last run.
6. Write the follow skill: the run, sorting, replies, limits, and status.
   Change the three rules for `reviewed` projects, under The donor's
   choice.
7. Set up wakes in each harness that has one, as in Harnesses, after
   trying each "Check" in the harness. Record what each check found in
   docs/architecture.md, as its harness notes do now.
8. Show follow-through on /me. This takes over the follow-ups half of #95.
9. Call the donor's trigger when a follow-up comes, with the form on /me
   that saves it, as in Waking a run when a follow-up comes.

Steps 1 to 3 can go in any order. Step 6 needs 1 to 5, 7 needs 6, and 9
needs 7 and 8.
